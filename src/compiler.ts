/** @module assemblyscript */ /** */

import * as base64 from "@protobufjs/base64";
import * as binaryen from "binaryen";
import * as Long from "long";
import * as nodePath from "path";

import * as builtins from "./builtins";
import * as expressions from "./expressions";
import compileStore from "./expressions/helpers/store";
import * as library from "./library";
import Memory from "./memory";
import Profiler from "./profiler";
import * as reflection from "./reflection";
import * as statements from "./statements";
import * as typescript from "./typescript";
import * as util from "./util";

/** Library name prefix. */
export const LIB_PREFIX = "lib:";
/** Standard name prefix. */
export const STD_PREFIX = "std:";

/** Compiler options. */
export interface CompilerOptions {
  /** Whether compilation shall be performed in silent mode without writing to console. Defaults to `false`. */
  silent?: boolean;
  /** Specifies the target architecture. Defaults to {@link CompilerTarget.WASM32}. */
  target?: CompilerTarget | "wasm32" | "wasm64";
  /** Whether to disable built-in tree-shaking. Defaults to `false`. */
  noTreeShaking?: boolean;
  /** Whether to disallow implicit type conversions. Defaults to `false`. */
  noImplicitConversion?: boolean;
  /** Whether to exclude the runtime. */
  noRuntime?: boolean;
  /** Runtime functions to export, defaults to 'malloc' and 'free'. */
  exportRuntime?: string[];
}

/** Compiler target. */
export enum CompilerTarget {
  /** 32-bit WebAssembly target using uint pointers. */
  WASM32,
  /** 64-bit WebAssembly target using ulong pointers. */
  WASM64
}

// Malloc, free, etc. is present as a base64 encoded blob and prepared once when required.
let runtimeCache: Uint8Array;

/**
 * The AssemblyScript compiler.
 *
 * Common usage is covered by the static methods {@link Compiler.compileFile} and {@link Compiler.compileString}
 * for convenience. Their diagnostics go to {@link Compiler.lastDiagnostics}.
 */
export class Compiler {

  /** Diagnostic messages reported by the last invocation of {@link Compiler.compileFile} or {@link Compiler.compileString}. */
  static lastDiagnostics: typescript.Diagnostic[];

  options: CompilerOptions;

  // TypeScript-related
  program: typescript.Program;
  checker: typescript.TypeChecker;
  entryFile: typescript.SourceFile;
  libraryFile: typescript.SourceFile;
  diagnostics: typescript.DiagnosticCollection;

  // Binaryen-related
  module: binaryen.Module;
  signatures: { [key: string]: binaryen.Signature } = {};
  globalInitializers: binaryen.Expression[] = [];

  // Codegen
  target: CompilerTarget;
  profiler = new Profiler();
  currentFunction: reflection.Function;
  runtimeExports: string[];

  // Reflection
  uintptrType: reflection.Type;
  functionTemplates: { [key: string]: reflection.FunctionTemplate } = {};
  classTemplates: { [key: string]: reflection.ClassTemplate } = {};
  globals: { [key: string]: reflection.Variable } = {};
  functions: { [key: string]: reflection.Function } = {};
  classes: { [key: string]: reflection.Class } = {};
  enums: { [key: string]: reflection.Enum } = {};
  startFunction: reflection.Function;
  startFunctionBody: typescript.Statement[] = [];
  pendingImplementations: { [key: string]: reflection.ClassTemplate } = {};
  memory: Memory;

  /**
   * Compiles an AssemblyScript file to WebAssembly.
   * @param filename Entry file name
   * @param options Compiler options
   * @returns Compiled module or `null` if compilation failed. In case of failure, diagnostics are stored in {@link Compiler#diagnostics}.
   */
  static compileFile(filename: string, options?: CompilerOptions): binaryen.Module | null {
    return Compiler.compileProgram(
      typescript.createProgram(
        Object.keys(library.files).concat(filename),
        typescript.defaultCompilerOptions,
        typescript.createCompilerHost([ process.cwd() ])
      ),
      options
    );
  }

  /**
   * Compiles an AssemblyScript string to WebAssembly.
   * @param source Source string
   * @param options Compiler options
   * @param fileName File to use for the entry file
   * @returns Compiled module or `null` if compilation failed. In case of failure, diagnostics are stored in {@link Compiler#diagnostics}.
   */
  static compileString(source: string, options?: CompilerOptions, fileName: string = "module.ts"): binaryen.Module | null {
    return Compiler.compileProgram(
      typescript.createProgram(
        Object.keys(library.files).concat(fileName),
        typescript.defaultCompilerOptions,
        typescript.createCompilerHost([], source, fileName)
      ), options
    );
  }

  /**
   * Compiles a TypeScript program using AssemblyScript syntax to WebAssembly.
   * @param program TypeScript program
   * @param options Compiler options
   * @returns Compiled module or `null` if compilation failed. In case of failure, diagnostics are stored in {@link Compiler#diagnostics}.
   */
  static compileProgram(program: typescript.Program, options?: CompilerOptions): binaryen.Module | null {
    const compiler = new Compiler(program, options);
    const silent = !!(options && options.silent);
    let hasErrors = false;

    Compiler.lastDiagnostics = [];

    // bail out if TypeScript reported 'pre emit' errors
    let diagnostics = typescript.getPreEmitDiagnostics(compiler.program);
    for (let i = 0, k = diagnostics.length; i < k; ++i) {
      if (!silent)
        typescript.printDiagnostic(diagnostics[i]);
      Compiler.lastDiagnostics.push(diagnostics[i]);
      if (diagnostics[i].category === typescript.DiagnosticCategory.Error)
        hasErrors = true;
    }
    if (hasErrors) return null;

    if (!silent)
      compiler.profiler.start("initialize");
    compiler.initialize();
    if (!silent)
      (console.error || console.log)("initialization took " + compiler.profiler.end("initialize").toFixed(3) + " ms");

    // bail out if AssemblyScript reported initialization errors
    diagnostics = compiler.diagnostics.getDiagnostics();
    for (let i = 0, k = diagnostics.length; i < k; ++i) {
      Compiler.lastDiagnostics.push(diagnostics[i]);
      if (diagnostics[i].category === typescript.DiagnosticCategory.Error)
        hasErrors = true;
    }
    if (hasErrors) return null;

    compiler.diagnostics = typescript.createDiagnosticCollection();

    if (!silent)
      compiler.profiler.start("compile");
    compiler.compile();
    if (!silent)
      (console.error || console.log)("compilation took " + compiler.profiler.end("compile").toFixed(3) + " ms\n");

    // bail out if AssemblyScript reported compilation errors
    diagnostics = compiler.diagnostics.getDiagnostics();
    for (let i = 0, k = diagnostics.length; i < k; ++i) {
      Compiler.lastDiagnostics.push(diagnostics[i]);
      if (diagnostics[i].category === typescript.DiagnosticCategory.Error)
        hasErrors = true;
    }
    if (hasErrors) return null;

    return compiler.module;
  }

  /** Gets the configured byte size of a pointer. `4` when compiling for 32-bit WebAssembly, `8` when compiling for 64-bit WebAssembly. */
  get uintptrSize(): number { return this.uintptrType.size; }

  /** Gets the size of an array header in bytes. */
  get arrayHeaderSize(): number { return 2 * reflection.intType.size; } // capacity + length

  /**
   * Constructs a new AssemblyScript compiler.
   * @param program TypeScript program
   * @param options Compiler options
   */
  constructor(program: typescript.Program, options?: CompilerOptions) {
    this.options = options || {};
    this.program = program;
    this.checker = program.getDiagnosticsProducingTypeChecker();
    this.diagnostics = typescript.createDiagnosticCollection();

    if (typeof this.options.target === "string") {
      if (this.options.target.toLowerCase() === "wasm64")
        this.target = CompilerTarget.WASM64;
      else
        this.target = CompilerTarget.WASM32;
    } else if (typeof this.options.target === "number" && CompilerTarget[this.options.target])
      this.target = this.options.target;
    else
      this.target = CompilerTarget.WASM32;

    if (!this.options.noRuntime) {
      if (!runtimeCache)
        base64.decode(library.runtime, runtimeCache = new Uint8Array(base64.length(library.runtime)), 0);
      this.module = binaryen.readBinary(runtimeCache);
      this.runtimeExports = this.options.exportRuntime || ["malloc", "free"];
    } else {
      this.module = new binaryen.Module();
      this.runtimeExports = [];
    }

    this.uintptrType = this.target === CompilerTarget.WASM64 ? reflection.uintptrType64 : reflection.uintptrType32;
    this.memory = new Memory(this, 32); // NULL + HEAP + MSPACE + GC, each aligned to 8 bytes

    const sourceFiles = program.getSourceFiles();
    for (let i = sourceFiles.length - 1; i >= 0; --i) {

      // the first declaration file is assumed to be the library file
      if (sourceFiles[i].isDeclarationFile)
          this.libraryFile = sourceFiles[i];

      // the last non-declaration file is assumed to be the entry file
      else if (!this.entryFile)
        this.entryFile = sourceFiles[i];
    }
  }

  /** Reports a diagnostic message (adds it to {@link Compiler#diagnostics}) and prints it. */
  report(node: typescript.Node, message: typescript.DiagnosticMessage, arg0?: string | number, arg1?: string | number, arg2?: string | number) {
    const diagnostic = typescript.createDiagnosticForNode(node, message, arg0, arg1, arg2);
    this.diagnostics.add(diagnostic);
    if (!(this.options && this.options.silent))
      typescript.printDiagnostic(diagnostic);
  }

  /** Mangles a global name (of a function, a class, ...) for use with binaryen. */
  mangleGlobalName(name: string, sourceFile: typescript.SourceFile) {
    if (sourceFile === this.libraryFile)
      name = LIB_PREFIX + name;
    else if (/^std\//.test(sourceFile.fileName))
      name = STD_PREFIX + name;
    else if (sourceFile !== this.entryFile)
      name = nodePath.relative(nodePath.dirname(this.entryFile.fileName), sourceFile.fileName)
      .replace(/\\/g, "/")
      .replace(/[^a-zA-Z0-9\.\/$]/g, "") + "/" + name;
    return name;
  }

  /** Scans over the sources and initializes the reflection structure. */
  initialize(): void {
    const sourceFiles = this.program.getSourceFiles();

    for (let i = 0, k = sourceFiles.length, file; i < k; ++i) {
      file = sourceFiles[i];

      for (let j = 0, l = file.statements.length, statement; j < l; ++j) {
        switch ((statement = file.statements[j]).kind) {

          case typescript.SyntaxKind.EndOfFileToken:
          case typescript.SyntaxKind.InterfaceDeclaration:
          case typescript.SyntaxKind.TypeAliasDeclaration:
          case typescript.SyntaxKind.ImportDeclaration:
            break; // already handled by TypeScript

          case typescript.SyntaxKind.VariableStatement:
            this.initializeGlobal(<typescript.VariableStatement>statement);
            break;

          case typescript.SyntaxKind.FunctionDeclaration:
            this.initializeFunction(<typescript.FunctionDeclaration>statement);
            break;

          case typescript.SyntaxKind.ClassDeclaration:
            this.initializeClass(<typescript.ClassDeclaration>statement);
            break;

          case typescript.SyntaxKind.EnumDeclaration:
            this.initializeEnum(<typescript.EnumDeclaration>statement);
            break;

          case typescript.SyntaxKind.ModuleDeclaration:
            // TODO: namespaces

          default:
            if (!typescript.isDeclaration(statement))
              this.startFunctionBody.push(statement);
            else
              this.report(statement, typescript.DiagnosticsEx.Unsupported_node_kind_0_in_1, statement.kind, "Compiler#initialize");
            break;
        }
      }
    }

    if (!this.options.noRuntime)
      this.initializeRuntime();
  }

  /** Gets an existing signature if it exists and otherwise creates it. */
  getOrAddSignature(argumentTypes: reflection.Type[], returnType: reflection.Type): binaryen.Signature {
    const identifiers: string[] = [];
    argumentTypes.forEach(type => identifiers.push(this.identifierOf(type)));
    identifiers.push(this.identifierOf(returnType));
    const identifier = identifiers.join("");
    let signature = this.signatures[identifier];
    if (!signature) {
      const binaryenArgumentTypes: binaryen.Type[] = argumentTypes.map(type => this.typeOf(type));
      const binaryenReturnType = this.typeOf(returnType);
      signature = this.signatures[identifier] = this.module.getFunctionTypeBySignature(binaryenReturnType, binaryenArgumentTypes)
                                             || this.module.addFunctionType(identifier, binaryenReturnType, binaryenArgumentTypes);
    }
    return signature;
  }

  /** Initializes the statically linked or imported runtime. */
  initializeRuntime(): void {
    if (this.options.noRuntime)
      return;

    // set up exports
    builtins.runtimeNames.forEach(fname => {
      if (this.runtimeExports.indexOf(fname) < 0)
        this.module.removeExport(fname); // does not throw if not existent
    });
  }

  /** Initializes a global variable. */
  initializeGlobal(node: typescript.VariableStatement): void {
    for (let i = 0, k = node.declarationList.declarations.length; i < k; ++i) {
      const declaration = node.declarationList.declarations[i];
      const initializerNode = declaration.initializer;

      if (declaration.type) {

        if (!declaration.symbol)
          throw Error("symbol expected");

        const name = this.mangleGlobalName(<string>declaration.symbol.escapedName, typescript.getSourceFileOfNode(declaration));
        const type = this.resolveType(declaration.type);

        if (type)
          this.addGlobal(name, type, !util.isConst(node.declarationList), initializerNode);
        // otherwise reported by resolveType

      } else
        this.report(declaration.name, typescript.DiagnosticsEx.Type_expected);
    }
  }

  /** Adds a global variable. */
  addGlobal(name: string, type: reflection.Type, mutable: boolean, initializerNode?: typescript.Expression): void {
    const op = this.module;
    let flags: reflection.VariableFlags = reflection.VariableFlags.global;
    if (!mutable)
      flags |= reflection.VariableFlags.constant;

    const global = this.globals[name] = new reflection.Variable(this, name, type, flags, 0);

    if (initializerNode) {

      if (initializerNode.kind === typescript.SyntaxKind.NumericLiteral) {
        op.addGlobal(name, this.typeOf(type), mutable, expressions.compileLiteral(this, <typescript.LiteralExpression>initializerNode, type));

      } else if (mutable) {
        op.addGlobal(name, this.typeOf(type), mutable, this.valueOf(type, 0));

        if (!this.startFunction)
          this.startFunction = createStartFunction(this);

        const previousFunction = this.currentFunction;
        this.currentFunction = this.startFunction;

        this.globalInitializers.push(
          op.setGlobal(name, this.compileExpression(initializerNode, type, type, false))
        );

        this.currentFunction = previousFunction;
      } else
        this.report(initializerNode, typescript.DiagnosticsEx.Unsupported_node_kind_0_in_1, initializerNode.kind, "Compiler#addGlobal");

    } else {
      let value: number = 0;
      switch (name) {
        case LIB_PREFIX + "NaN":
        case LIB_PREFIX + "NaNf":
          value = NaN;
          break;
        case LIB_PREFIX + "Infinity":
        case LIB_PREFIX + "Infinityf":
          value = Infinity;
          break;
      }
      if (global.isConstant) // enable inlining so these globals can be eliminated by the optimizer
        global.value = value;
      op.addGlobal(name, this.typeOf(type), mutable, this.valueOf(type, value));
    }
  }

  /** Initializes a top-level function. */
  initializeFunction(node: typescript.FunctionDeclaration): reflection.FunctionHandle {

    if (node.parent && node.parent.kind === typescript.SyntaxKind.ClassDeclaration)
      throw Error("not a top-level function");

    // determine the function's global name
    const name = this.mangleGlobalName(
      typescript.getTextOfNode(<typescript.Identifier>node.name),
      typescript.getSourceFileOfNode(node)
    );

    // obtain or create the template
    let template = this.functionTemplates[name];
    if (!template)
      template = new reflection.FunctionTemplate(this, name, node);

    // instantiate it if applicable
    let instance: reflection.Function | undefined;
    if (template.isGeneric) {
      // special case: generic builtins evaluate type parameters dynamically and have a known return type
      if (builtins.isBuiltinFunction(name, false))
        instance = new reflection.Function(this, name, template, [], {}, [], this.resolveType(<typescript.TypeNode>template.declaration.type, true) || reflection.voidType);
    } else
      instance = template.resolve([]);

    return { template, instance };
  }

  /** Initializes a class. */
  initializeClass(node: typescript.ClassDeclaration): reflection.ClassHandle {

    // determine the class's global name
    const sourceFile = typescript.getSourceFileOfNode(node);
    const simpleName = typescript.getTextOfNode(<typescript.Identifier>node.name);
    const name = this.mangleGlobalName(simpleName, sourceFile);

    // check if it is already initialized
    let template = this.classTemplates[name];
    if (template) {
      if (template.declaration !== node)
        throw Error("duplicate global name: " + name);
      return {
        template: template,
        instance: util.getReflectedClass(template.declaration)
      };
    }

    // handle inheritance
    let base: reflection.ClassTemplate | undefined;
    let baseTypeArguments: typescript.NodeArray<typescript.TypeNode> | typescript.TypeNode[] | undefined;
    if (node.heritageClauses) {
      for (let i = 0, k = node.heritageClauses.length; i < k; ++i) {
        const clause = node.heritageClauses[i];
        if (clause.token === typescript.SyntaxKind.ExtendsKeyword) {
          if (clause.types.length !== 1)
            throw Error("expected exactly one extended class");
          const extendsNode = clause.types[0];
          if (extendsNode.expression.kind === typescript.SyntaxKind.Identifier) {
            const reference = this.resolveReference(<typescript.Identifier>extendsNode.expression, reflection.ObjectFlags.ClassTemplate);
            if (reference instanceof reflection.ClassTemplate) {
              base = reference;
              baseTypeArguments = extendsNode.typeArguments || [];
            } else
              this.report(extendsNode.expression, typescript.DiagnosticsEx.Unresolvable_type_0, typescript.getTextOfNode(extendsNode.expression));
          } else
            this.report(extendsNode.expression, typescript.DiagnosticsEx.Unsupported_node_kind_0_in_1, extendsNode.expression.kind, "Compiler#initializeClass/1");
        } else if (clause.token === typescript.SyntaxKind.ImplementsKeyword) {
          // TODO
        } else
          this.report(clause, typescript.DiagnosticsEx.Unsupported_node_kind_0_in_1, clause.token, "Compiler#initializeClass/2");
      }
    }

    // create the template and instantiate it if applicable
    template = new reflection.ClassTemplate(this, name, node, base, baseTypeArguments);
    let instance: reflection.Class | undefined;
    if (!template.isGeneric)
      instance = template.resolve([]);

    // remember standard library declarations that need to be implemented
    if (sourceFile === this.libraryFile)
      this.pendingImplementations[simpleName] = template;

    // respectively replace the declaration with the implementation later on
    else if (this.pendingImplementations[simpleName])
      reflection.patchClassImplementation(this.pendingImplementations[simpleName], template);

    return { template, instance };
  }

  /** Initializes a static method. */
  initializeStaticMethod(node: typescript.MethodDeclaration | typescript.GetAccessorDeclaration | typescript.SetAccessorDeclaration): reflection.FunctionHandle {

    if (!node.parent || node.parent.kind !== typescript.SyntaxKind.ClassDeclaration)
      throw Error("missing parent");
    if (!util.isStatic(node))
      throw Error("not a static method");

    // determine the method's global name
    const name = this.mangleGlobalName(
      typescript.getTextOfNode(<typescript.Identifier>(<typescript.ClassDeclaration>node.parent).name) + "." + typescript.getTextOfNode(<typescript.Identifier>node.name),
      typescript.getSourceFileOfNode(node)
    );

    // obtain or create the template
    let template = this.functionTemplates[name];
    if (!template)
      template = new reflection.FunctionTemplate(this, name, node/*, parent is irrelevant here */);

    // instantiate it if applicable
    let instance: reflection.Function | undefined;
    if (!template.isGeneric)
      instance = template.resolve([]);

    return { template, instance };
  }

  /** Initializes an instance method. */
  initializeInstanceMethod(node: typescript.MethodDeclaration | typescript.GetAccessorDeclaration | typescript.SetAccessorDeclaration | typescript.ConstructorDeclaration, parent: reflection.Class): reflection.FunctionHandle {

    if (!node.parent || node.parent.kind !== typescript.SyntaxKind.ClassDeclaration)
      throw Error("missing parent");
    if (util.isStatic(node))
      throw Error("not an instance method");

    // determine the method's global name
    let name: string;
    let prefix = "";

    if (node.kind === typescript.SyntaxKind.GetAccessor)
      prefix = "get_";
    else if (node.kind === typescript.SyntaxKind.SetAccessor)
      prefix = "set_";

    // constructors just use the class's name
    if (node.kind === typescript.SyntaxKind.Constructor)
      name = parent.name;

    // instance functions are separated with a hash
    else
      name = parent.name + "#" + prefix + typescript.getTextOfNode(<typescript.Identifier>node.name);

    // obtain or create the template
    let template = this.functionTemplates[name];
    if (!template)
      template = new reflection.FunctionTemplate(this, name, node, parent);

    // instantiate it if applicable
    let instance: reflection.Function | undefined;
    if (!template.isGeneric)
      instance = template.resolve([]);

    return { template, instance };
  }

  /** Initializes an enum. */
  initializeEnum(node: typescript.EnumDeclaration): reflection.Enum {

    // determine the enum's global name
    const name = this.mangleGlobalName(typescript.getTextOfNode(node.name), typescript.getSourceFileOfNode(node));

    // check if it is already initialized
    if (this.enums[name])
      return this.enums[name];

    // enums cannot be exported yet (only functions are supported)
    if (typescript.getSourceFileOfNode(node) === this.entryFile && util.isExport(node))
      this.report(node.name, typescript.DiagnosticsEx.Unsupported_modifier_0, "export");

    // create the instance
    return new reflection.Enum(this, name, node); // registers as a side-effect
  }

  /** Compiles the module and its components. */
  compile(): void {

    const sourceFiles = this.program.getSourceFiles();
    for (let i = 0, k = sourceFiles.length; i < k; ++i) {

      if (sourceFiles[i].isDeclarationFile)
        continue;

      for (const statement of sourceFiles[i].statements) {

        if (!this.options.noTreeShaking)
          if (!(util.isExport(statement) && typescript.getSourceFileOfNode(statement) === this.entryFile))
            continue;

        switch (statement.kind) {

          case typescript.SyntaxKind.FunctionDeclaration:
          {
            const declaration = <typescript.FunctionDeclaration>statement;
            const instance = util.getReflectedFunction(declaration);
            if (instance && !instance.compiled) // otherwise generic: compiled once type arguments are known
              this.compileFunction(instance);
            break;
          }

          case typescript.SyntaxKind.ClassDeclaration:
          {
            const declaration = <typescript.ClassDeclaration>statement;
            const instance = util.getReflectedClass(declaration);
            if (instance) // otherwise generic: compiled once type arguments are known
              this.compileClass(instance);
            break;
          }

          // otherwise already handled or reported by initialize
        }
      }
    }

    // setup static memory
    const binaryenSegments: binaryen.MemorySegment[] = [];
    this.memory.segments.forEach(segment => {
      binaryenSegments.push({
        offset: this.valueOf(this.uintptrType, segment.offset),
        data: segment.buffer
      });
    });

    // initialize runtime heap pointer
    const heapOffset = this.memory.align();
    if (!this.options.noRuntime) {
      binaryenSegments.unshift({
        offset: this.valueOf(this.uintptrType, 8),
        data: new Uint8Array([
           heapOffset.low          & 0xff,
          (heapOffset.low  >>>  8) & 0xff,
          (heapOffset.low  >>> 16) & 0xff,
          (heapOffset.low  >>> 24) & 0xff,
           heapOffset.high         & 0xff,
          (heapOffset.high >>>  8) & 0xff,
          (heapOffset.high >>> 16) & 0xff,
          (heapOffset.high >>> 24) & 0xff
        ])
      });
    }

    const initialSize = Math.floor((heapOffset.sub(1).toNumber()) / 65536) + 1;
    this.module.setMemory(initialSize, 0xffff, this.options.noRuntime ? "memory" :  undefined, binaryenSegments);

    // compile start function (initializes malloc mspaces)
    this.maybeCompileStartFunction();
  }

  /** Compiles the start function if either a user-provided start function is or global initializes are present. */
  maybeCompileStartFunction(): void {

    if (this.globalInitializers.length === 0 && this.startFunctionBody.length === 0 && this.options.noRuntime)
      return;

    const op = this.module;

    // create a blank start function if there isn't one already
    if (!this.startFunction)
      this.startFunction = createStartFunction(this);
    const previousFunction = this.currentFunction;
    this.currentFunction = this.startFunction;

    const body: binaryen.Statement[] = [];

    // call init first if the runtime is bundled
    if (!this.options.noRuntime)
      body.push(
        op.call(".init", [], binaryen.none)
      );

    // include global initializes
    let i = 0;
    for (const k = this.globalInitializers.length; i < k; ++i)
      body.push(this.globalInitializers[i]); // usually a setGlobal

    // compile top-level statements
    this.startFunctionBody.forEach(stmt => body.push(statements.compile(this, stmt)));

    // make sure to check for additional locals
    const additionalLocals: binaryen.Type[] = [];
    for (i = 0; i < this.startFunction.locals.length; ++i)
      additionalLocals.push(this.typeOf(this.startFunction.locals[i].type));

    // and finally add the function
    const startSignature = this.getOrAddSignature([], reflection.voidType);
    this.module.setStart(
      this.module.addFunction(this.startFunction.name, startSignature, additionalLocals, op.block("", body))
    );

    this.currentFunction = previousFunction;
  }

  /** Compiles a malloc invocation using the specified byte size. */
  compileMallocInvocation(size: number, clearMemory: boolean = true): binaryen.Expression {
    const op = this.module;

    const mallocFunction = this.functions[LIB_PREFIX + "malloc"];
    const memsetFunction = this.functions[LIB_PREFIX + "memset"];

    // Simplify if possible but always obtain a pointer for consistency
    if (size === 0 || !clearMemory)
      return mallocFunction.call([ this.valueOf(this.uintptrType, size) ]);

    return memsetFunction.call([
      mallocFunction.call([
        this.valueOf(this.uintptrType, size)
      ]),
      op.i32.const(0), // 2nd memset argument is int
      this.valueOf(this.uintptrType, size)
    ]);
  }

  /** Compiles a function. */
  compileFunction(instance: reflection.Function): binaryen.Function | null {
    const op = this.module;

    if (instance.compiled)
      throw Error("duplicate compilation of function " + instance);

    // register signature
    if (!instance.binaryenSignature)
      instance.binaryenSignature = this.signatureOf(instance);
    instance.compiled = true;

    // handle imports
    if (instance.isImport) {
      if (instance.imported)
        throw Error("duplicate compilation of imported function " + instance);

      const sourceFile = typescript.getSourceFileOfNode(instance.declaration);
      let pos: number;

      let importModuleName: string;
      let importFunctionName = instance.simpleName;

      if (builtins.isLibraryFile(sourceFile))
        importModuleName = "lib";
      else if (builtins.isStandardFile(sourceFile))
        importModuleName = "std";
      else if ((pos = importFunctionName.indexOf("$")) > -1) {
        importModuleName = importFunctionName.substring(0, pos);
        importFunctionName = importFunctionName.substring(pos + 1);
      } else
        importModuleName = "env";

      this.module.addImport(instance.name, importModuleName, importFunctionName, instance.binaryenSignature);
      instance.imported = true;
      return null;
    }

    // handle statically linked runtime functions
    if (builtins.isRuntimeFunction(instance.name))
      return null;

    // otherwise compile
    if (!instance.body)
      throw Error("cannot compile a non-import function without a body: " + instance.name);

    const body: binaryen.Statement[] = [];
    const previousFunction = this.currentFunction;
    this.currentFunction = instance;
    const initialLocalsIndex = instance.locals.length;

    for (let i = /* skip this */ 1; i < instance.parameters.length; ++i) {
      const param = instance.parameters[i];
      if (param.isAlsoProperty) {
        const property = (<reflection.Class>instance.parent).properties[param.name];
        if (property)
          body.push(
            compileStore(this, /* solely used for diagnostics anyway */ <typescript.Expression>param.node, property.type, op.getLocal(0, this.typeOf(this.uintptrType)), property.offset, op.getLocal(i, this.typeOf(param.type)))
          );
        else
          throw Error("missing parameter property");
      }
    }

    if (instance.body.kind === typescript.SyntaxKind.Block) {
      const blockNode = <typescript.Block>instance.body;
      for (let i = 0, k = blockNode.statements.length; i < k; ++i) {
        const statementNode = blockNode.statements[i];
        body.push(this.compileStatement(statementNode));
      }
    } else {
      const expressionNode = <typescript.Expression>instance.body;
      body.push(op.return(
        this.compileExpression(expressionNode, instance.returnType)
      ));
    }

    const binaryenPtrType = this.typeOf(this.uintptrType);

    if (instance.isConstructor && (<reflection.Class>instance.parent).implicitMalloc) {

      // constructors implicitly return 'this' if implicit malloc is enabled
      body.push(
        op.return(
          op.getLocal(0, binaryenPtrType)
        )
      );

      // initialize instance properties
      const properties = (<reflection.Class>instance.parent).properties;
      let bodyIndex = 0;
      Object.keys(properties).forEach(key => {
        const property = properties[key];
        if (property.isInstance && property.initializer) {
          body.splice(bodyIndex++, 0,
            compileStore(this, property.initializer, property.type,
              op.getLocal(0, binaryenPtrType), property.offset,
              this.compileExpression(property.initializer, property.type, property.type, false)
            )
          );
        }
      });

    } // TODO: what to do with instance property initializers with explicit malloc? set afterwards, using the ctor's return value?

    const additionalLocals = instance.locals.slice(initialLocalsIndex).map(local => this.typeOf(local.type));
    const binaryenFunction = instance.binaryenFunction = this.module.addFunction(instance.name, instance.binaryenSignature, additionalLocals, op.block("", body));

    if (instance.isExport)
      this.module.addExport(instance.name, instance.name);

    this.currentFunction = previousFunction;
    return binaryenFunction;
  }

  /** Compiles a class. */
  compileClass(instance: reflection.Class): void {
    for (let i = 0, k = instance.declaration.members.length; i < k; ++i) {
      const member = instance.declaration.members[i];
      switch (member.kind) {

        case typescript.SyntaxKind.Constructor:
        case typescript.SyntaxKind.MethodDeclaration:
        {
          const methodDeclaration = <typescript.ConstructorDeclaration | typescript.MethodDeclaration>member;
          if (util.isExport(methodDeclaration, true) || this.options.noTreeShaking) {
            const functionInstance = util.getReflectedFunction(methodDeclaration);
            if (functionInstance && !functionInstance.compiled) // otherwise generic: compiled once type arguments are known
              this.compileFunction(functionInstance);
          }
          break;
        }

        // otherwise already reported by initialize
      }
    }
  }

  /** Amends the current break context when entering a loop, switch or similar. */
  enterBreakContext(): string {
    if (this.currentFunction.breakDepth === 0)
      ++this.currentFunction.breakNumber;
    ++this.currentFunction.breakDepth;
    return this.currentFunction.breakLabel;
  }

  /** Amends the current break context when leaving a loop, switch or similar. */
  leaveBreakContext(): void {
    if (this.currentFunction.breakDepth < 1)
      throw Error("unbalanced break context");
    --this.currentFunction.breakDepth;
  }

  /** Textual break label according to the current break context state. */
  get currentBreakLabel(): string { return this.currentFunction.breakLabel; }

  /** Compiles a statement. */
  compileStatement(node: typescript.Statement): binaryen.Statement {
    return statements.compile(this, node);
  }

  /** Compiles an expression. */
  compileExpression(node: typescript.Expression, contextualType: reflection.Type, convertToType?: reflection.Type, convertExplicit: boolean = false): binaryen.Expression {
    let expr = expressions.compile(this, node, contextualType);
    if (convertToType)
      expr = this.maybeConvertValue(node, expr, util.getReflectedType(node), convertToType, convertExplicit);
    return expr;
  }

  /** Wraps an expression with a conversion where necessary. */
  maybeConvertValue(node: typescript.Expression, expr: binaryen.Expression, fromType: reflection.Type, toType: reflection.Type, explicit: boolean): binaryen.Expression {
    const compiler = this;
    const op = this.module;

    function illegalImplicitConversion() {
      compiler.report(node, typescript.DiagnosticsEx.Conversion_from_0_to_1_requires_an_explicit_cast, fromType.toString(), toType.toString());
      explicit = true; // report this only once for the topmost node
    }

    // no conversion required
    if (fromType.kind === toType.kind) {

      if (fromType.kind === reflection.TypeKind.uintptr && fromType.underlyingClass !== toType.underlyingClass)
        compiler.report(node, typescript.DiagnosticsEx.Types_0_and_1_are_incompatible, toType.underlyingClass ? toType.underlyingClass.toString() : "uintptr", fromType.underlyingClass ? fromType.underlyingClass.toString() : "uintptr");

      return expr;
    }

    // possibly disallowed implicit conversion
    if (!explicit && this.options.noImplicitConversion)
      illegalImplicitConversion();

    if (!explicit) {

      if (
        (this.uintptrSize === 4 && fromType.kind === reflection.TypeKind.uintptr && toType.isInt) ||
        (this.uintptrSize === 8 && fromType.isLong && toType.kind === reflection.TypeKind.uintptr)
      )
        this.report(node, typescript.DiagnosticsEx.Conversion_from_0_to_1_will_fail_when_switching_between_WASM32_64, fromType.toString(), toType.toString());
    }

    util.setReflectedType(node, toType);

    if (fromType === reflection.floatType) {

      if (!explicit && toType !== reflection.doubleType)
        illegalImplicitConversion();

      switch (toType) {

        case reflection.byteType:
        case reflection.ushortType:
        case reflection.uintType:
        case reflection.uintptrType32:
        case reflection.boolType:
          return this.maybeConvertValue(node, op.i32.trunc_u.f32(expr), reflection.intType, toType, explicit);

        case reflection.sbyteType:
        case reflection.shortType:
        case reflection.intType:
          return this.maybeConvertValue(node, op.i32.trunc_s.f32(expr), reflection.intType, toType, explicit);

        case reflection.uintptrType64:
        case reflection.ulongType:
          return op.i64.trunc_u.f32(expr);

        case reflection.longType:
          return op.i64.trunc_s.f32(expr);

        // floatType == floatType

        case reflection.doubleType:
          return op.f64.promote(expr);

      }

    } else if (fromType === reflection.doubleType) {

      if (!explicit) illegalImplicitConversion();

      switch (toType) {

        case reflection.byteType:
        case reflection.ushortType:
        case reflection.uintType:
        case reflection.uintptrType32:
        case reflection.boolType:
          return this.maybeConvertValue(node, op.i32.trunc_u.f64(expr), reflection.intType, toType, explicit); // maybe mask

        case reflection.sbyteType:
        case reflection.shortType:
        case reflection.intType:
          return this.maybeConvertValue(node, op.i32.trunc_s.f64(expr), reflection.intType, toType, explicit); // maybe sign extend

        case reflection.ulongType:
        case reflection.uintptrType64:
          return op.i64.trunc_u.f64(expr);

        case reflection.longType:
          return op.i64.trunc_s.f64(expr);

        case reflection.floatType:
          return op.f32.demote(expr);

        // doubleType == doubleType

      }

    } else if (toType === reflection.floatType) { // int to float

      switch (fromType) {

        case reflection.uintType:
        case reflection.uintptrType32:
          if (!explicit) illegalImplicitConversion();

        case reflection.byteType:
        case reflection.ushortType:
        case reflection.boolType:
          return op.f32.convert_u.i32(expr);

        case reflection.intType:
          if (!explicit) illegalImplicitConversion();

        case reflection.sbyteType:
        case reflection.shortType:
          return op.f32.convert_s.i32(expr);

        case reflection.ulongType:
        case reflection.uintptrType64:
          if (!explicit) illegalImplicitConversion();
          return op.f32.convert_u.i64(expr);

        case reflection.longType:
          if (!explicit) illegalImplicitConversion();
          return op.f32.convert_s.i64(expr);

      }

    } else if (toType === reflection.doubleType) { // int to double

      switch (fromType) {

        case reflection.uintType:
        case reflection.uintptrType32:
        case reflection.byteType:
        case reflection.ushortType:
        case reflection.boolType:
          return op.f64.convert_u.i32(expr);

        case reflection.intType:
        case reflection.sbyteType:
        case reflection.shortType:
          return op.f64.convert_s.i32(expr);

        case reflection.ulongType:
        case reflection.uintptrType64:
          if (!explicit) illegalImplicitConversion();
          return op.f64.convert_u.i64(expr);

        case reflection.longType:
          if (!explicit) illegalImplicitConversion();
          return op.f64.convert_s.i64(expr);

      }

    } else if (fromType.isInt && toType.isLong) {

      if (toType.isSigned)
        return op.i64.extend_s(expr);
      else
        return op.i64.extend_u(expr);

    } else if (fromType.isLong && toType.isInt) {

      if (!explicit) illegalImplicitConversion();

      expr = op.i32.wrap(expr);
      fromType = fromType.isSigned ? reflection.intType : reflection.uintType;

      // fallthrough
    }

    // int to other int

    if (fromType.size < toType.size || toType.isInt)
      return expr;

    if (!explicit) illegalImplicitConversion();

    if (toType.isSigned) { // sign-extend

      const shift = toType === reflection.sbyteType ? 24 : 16;
      return op.i32.shr_s(
        op.i32.shl(
          expr,
          op.i32.const(shift)
        ),
        op.i32.const(shift)
      );

    } else { // mask

      const mask = toType === reflection.byteType ? 0xff : 0xffff;
      return op.i32.and(
        expr,
        op.i32.const(mask)
      );

    }
  }

  /** Resolves a TypeScript type alias to the root AssemblyScript type where applicable, by symbol. */
  maybeResolveAlias(symbol: typescript.Symbol): typescript.Symbol {

    // Exit early (before hitting 'number') if it's a built in type
    switch (symbol.escapedName) {
      case "byte":
      case "sbyte":
      case "short":
      case "ushort":
      case "int":
      case "uint":
      case "long":
      case "ulong":
      case "bool":
      case "float":
      case "double":
      case "uintptr":
      case "string":
        return symbol;
    }

    // Otherwise follow any aliases to the original type
    if (symbol.declarations)
      for (let i = 0, k = symbol.declarations.length; i < k; ++i) {
        const declaration = symbol.declarations[i];
        if (declaration.kind === typescript.SyntaxKind.TypeAliasDeclaration) {
          const aliasDeclaration = <typescript.TypeAliasDeclaration>declaration;
          if (aliasDeclaration.type.kind === typescript.SyntaxKind.TypeReference) {
            const symbolAtLocation = this.checker.getSymbolAtLocation((<typescript.TypeReferenceNode>aliasDeclaration.type).typeName);
            if (symbolAtLocation)
              return this.maybeResolveAlias(symbolAtLocation);
          }
        }
      }

    return symbol;
  }

  /** Resolves a TypeScript type to a AssemblyScript type. */
  resolveType(type: typescript.TypeNode, acceptVoid: boolean = false, typeArgumentsMap?: reflection.TypeArgumentsMap): reflection.Type | null {

    switch (type.kind) {

      case typescript.SyntaxKind.VoidKeyword:
        if (!acceptVoid)
          this.report(type, typescript.DiagnosticsEx.Type_0_is_invalid_in_this_context, "void");
        return reflection.voidType;

      case typescript.SyntaxKind.BooleanKeyword:
        this.report(type, typescript.DiagnosticsEx.Assuming_0_instead_of_1, "bool", "boolean");
        return reflection.boolType;

      case typescript.SyntaxKind.NumberKeyword:
        this.report(type, typescript.DiagnosticsEx.Assuming_0_instead_of_1, "double", "number");
        return reflection.doubleType;

      case typescript.SyntaxKind.ThisKeyword:
      case typescript.SyntaxKind.ThisType:
        if (this.currentFunction && this.currentFunction.parent)
          return this.currentFunction.parent.type;
        // fallthrough

      case typescript.SyntaxKind.TypeReference:
      {
        const typeName = typescript.getTextOfNode(type);
        if (typeArgumentsMap && typeArgumentsMap[typeName])
          return typeArgumentsMap[typeName].type;

        const referenceNode = <typescript.TypeReferenceNode>type;
        const symbolAtLocation = this.checker.getSymbolAtLocation(referenceNode.typeName);
        if (symbolAtLocation) {
          const symbol = this.maybeResolveAlias(symbolAtLocation);
          if (symbol) {

            // Exit early if it's a basic type
            switch (symbol.escapedName) {
              case "byte": return reflection.byteType;
              case "sbyte": return reflection.sbyteType;
              case "short": return reflection.shortType;
              case "ushort": return reflection.ushortType;
              case "int": return reflection.intType;
              case "uint": return reflection.uintType;
              case "long": return reflection.longType;
              case "ulong": return reflection.ulongType;
              case "bool": return reflection.boolType;
              case "float": return reflection.floatType;
              case "double": return reflection.doubleType;
              case "uintptr": return this.uintptrType;
              case "string": return this.classes[LIB_PREFIX + "String"].type;
            }

            const reference = this.resolveReference(referenceNode.typeName, reflection.ObjectFlags.ClassInclTemplate);

            if (reference instanceof reflection.Class)
              return (<reflection.Class>reference).type;

            if (reference instanceof reflection.ClassTemplate && referenceNode.typeArguments) {
              const template = <reflection.ClassTemplate>reference;
              const instance = template.resolve(referenceNode.typeArguments, typeArgumentsMap);
              return instance.type;
            }
          }
        }
        break;
      }

      case typescript.SyntaxKind.StringKeyword: {
        const stringClass = this.classes[LIB_PREFIX + "String"];
        if (!stringClass)
          throw Error("missing string class");
        return stringClass.type;
      }

      case typescript.SyntaxKind.ArrayType:
      {
        const arrayTypeNode = <typescript.ArrayTypeNode>type;
        const template = this.classTemplates[LIB_PREFIX + "Array"];
        const instance = template.resolve([ arrayTypeNode.elementType ]);
        return instance.type;
      }
    }

    this.report(type, typescript.DiagnosticsEx.Unresolvable_type_0, typescript.getTextOfNode(type));
    return null;
  }

  /** Resolves an identifier or name to the corresponding reflection object. */
  resolveReference(node: typescript.Identifier | typescript.EntityName, filter: reflection.ObjectFlags = reflection.ObjectFlags.Any): reflection.Object | null {

    // Locals including 'this'
    const localName = typescript.getTextOfNode(node);
    if (this.currentFunction && this.currentFunction.localsByName[localName])
      return this.currentFunction.localsByName[localName];

    // Globals, enums, functions and classes
    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.declarations) { // Determine declaration site

      for (let i = 0, k = symbol.declarations.length; i < k; ++i) {
        const declaration = symbol.declarations[i];
        const globalName = this.mangleGlobalName(<string>symbol.escapedName, typescript.getSourceFileOfNode(declaration));

        if (filter & reflection.ObjectFlags.Variable && this.globals[globalName])
          return this.globals[globalName];

        if (filter & reflection.ObjectFlags.Enum && this.enums[globalName])
          return this.enums[globalName];

        if (filter & reflection.ObjectFlags.Function && this.functions[globalName])
          return this.functions[globalName];

        if (filter & reflection.ObjectFlags.FunctionTemplate && this.functionTemplates[globalName])
          return this.functionTemplates[globalName];

        if (filter & reflection.ObjectFlags.Class && this.classes[globalName])
          return this.classes[globalName];

        if (filter & reflection.ObjectFlags.ClassTemplate && this.classTemplates[globalName])
          return this.classTemplates[globalName];
      }
    }
    return null;
  }

  /** Resolves a list of type arguments to a type arguments map. */
  resolveTypeArgumentsMap(typeArguments: typescript.NodeArray<typescript.TypeNode> | typescript.TypeNode[], declaration: typescript.FunctionLikeDeclaration | typescript.ClassDeclaration, baseTypeArgumentsMap?: reflection.TypeArgumentsMap): reflection.TypeArgumentsMap {
    const declarationTypeCount = declaration.typeParameters && declaration.typeParameters.length || 0;
    if (typeArguments.length !== declarationTypeCount)
      throw Error("type parameter count mismatch: expected " + declarationTypeCount + " but saw " + typeArguments.length);
    const map: reflection.TypeArgumentsMap = baseTypeArgumentsMap && Object.create(baseTypeArgumentsMap) || {};
    for (let i = 0; i < declarationTypeCount; ++i) {
      const name = typescript.getTextOfNode((<typescript.NodeArray<typescript.TypeParameterDeclaration>>declaration.typeParameters)[i].name);
      const node = typeArguments[i];
      const type = baseTypeArgumentsMap && baseTypeArgumentsMap[name] && baseTypeArgumentsMap[name].type || this.resolveType(node, false, baseTypeArgumentsMap) || reflection.voidType; // reports
      map[name] = { node, type };
    }
    return map;
  }

  /** Computes the binaryen signature identifier of a reflected type. */
  identifierOf(type: reflection.Type): string {
    switch (type.kind) {

      case reflection.TypeKind.sbyte:
      case reflection.TypeKind.byte:
      case reflection.TypeKind.short:
      case reflection.TypeKind.ushort:
      case reflection.TypeKind.int:
      case reflection.TypeKind.uint:
      case reflection.TypeKind.bool:
        return "i";

      case reflection.TypeKind.long:
      case reflection.TypeKind.ulong:
        return "I";

      case reflection.TypeKind.float:
        return "f";

      case reflection.TypeKind.double:
        return "F";

      case reflection.TypeKind.uintptr:
        return this.uintptrType === reflection.uintptrType32 ? "i" : "I";

      case reflection.TypeKind.void:
        return "v";
    }
    throw Error("unexpected type");
  }

  /** Obtains the signature of the specified reflected function. */
  signatureOf(instance: reflection.Function): binaryen.Signature {
    let signature = instance.binaryenSignature;
    if (!signature) {
      signature = this.module.getFunctionTypeBySignature(instance.binaryenReturnType, instance.binaryenParameterTypes);
      if (!signature)
        signature = this.module.addFunctionType(instance.binaryenSignatureId, instance.binaryenReturnType, instance.binaryenParameterTypes);
    }
    return signature;
  }

  /** Computes the binaryen type of a reflected type. */
  typeOf(type: reflection.Type): binaryen.Type {
    switch (type.kind) {

      case reflection.TypeKind.sbyte:
      case reflection.TypeKind.byte:
      case reflection.TypeKind.short:
      case reflection.TypeKind.ushort:
      case reflection.TypeKind.int:
      case reflection.TypeKind.uint:
      case reflection.TypeKind.bool:
        return binaryen.i32;

      case reflection.TypeKind.long:
      case reflection.TypeKind.ulong:
        return binaryen.i64;

      case reflection.TypeKind.float:
        return binaryen.f32;

      case reflection.TypeKind.double:
        return binaryen.f64;

      case reflection.TypeKind.uintptr:
        return this.uintptrType === reflection.uintptrType32 ? binaryen.i32 : binaryen.i64;

      case reflection.TypeKind.void:
        return binaryen.none;
    }
    throw Error("unexpected type");
  }

  /** Computes the binaryen opcode category (i32, i64, f32, f64) of a reflected type. */
  categoryOf(type: reflection.Type): binaryen.I32Operations | binaryen.I64Operations | binaryen.F32Operations | binaryen.F64Operations {
    const op = this.module;

    switch (type.kind) {

      case reflection.TypeKind.sbyte:
      case reflection.TypeKind.byte:
      case reflection.TypeKind.short:
      case reflection.TypeKind.ushort:
      case reflection.TypeKind.int:
      case reflection.TypeKind.uint:
      case reflection.TypeKind.bool:
        return op.i32;

      case reflection.TypeKind.long:
      case reflection.TypeKind.ulong:
        return op.i64;

      case reflection.TypeKind.float:
        return op.f32;

      case reflection.TypeKind.double:
        return op.f64;

      case reflection.TypeKind.uintptr:
        return this.uintptrType === reflection.uintptrType32 ? op.i32 : op.i64;
    }
    throw Error("unexpected type");
  }

  /** Computes the constant value binaryen expression of the specified reflected type. */
  valueOf(type: reflection.Type, value: number | Long): binaryen.Expression {
    const op = this.module;

    if (type.isLong) {
      const long = Long.fromValue(value);
      return op.i64.const(long.low, long.high);
    } else if (Long.isLong(value))
      value = Long.fromValue(value).toNumber();

    value = <number>value;

    switch (type.kind) {

      case reflection.TypeKind.byte:
        return op.i32.const(value & 0xff);

      case reflection.TypeKind.sbyte:
        return op.i32.const((value << 24) >> 24);

      case reflection.TypeKind.short:
        return op.i32.const((value << 16) >> 16);

      case reflection.TypeKind.ushort:
        return op.i32.const(value & 0xffff);

      case reflection.TypeKind.int:
      case reflection.TypeKind.uint:
      case reflection.TypeKind.uintptr: // long already handled
        return op.i32.const(value);

      case reflection.TypeKind.bool:
        return op.i32.const(value ? 1 : 0);

      case reflection.TypeKind.float:
        return op.f32.const(value);

      case reflection.TypeKind.double:
        return op.f64.const(value);
    }
    throw Error("unexpected type");
  }

  debugInfo(): string {
    const sb: string[] = [];
    sb.push("--- classes ---\n");
    Object.keys(this.classes).forEach(key => {
      sb.push(key, ": ", this.classes[key].toString(), "\n");
    });
    sb.push("--- class templates ---\n");
    Object.keys(this.classTemplates).forEach(key => {
      sb.push(key, ": ", this.classTemplates[key].toString(), "\n");
    });
    sb.push("--- functions ---\n");
    Object.keys(this.functions).forEach(key => {
      sb.push(key, ": ", this.functions[key].toString(), "\n");
    });
    sb.push("--- function templates ---\n");
    Object.keys(this.functionTemplates).forEach(key => {
      sb.push(key, ": ", this.functionTemplates[key].toString(), "\n");
    });
    return sb.join("");
  }
}

export { Compiler as default };

/** Creates a new reflected start function. */
function createStartFunction(compiler: Compiler): reflection.Function {
  return new reflection.Function(compiler, ".start", new reflection.FunctionTemplate(compiler, ".start", <typescript.FunctionLikeDeclaration>{}), [], {}, [], reflection.voidType);
}
