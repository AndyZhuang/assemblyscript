/**
 * Compiler components dealing with TypeScript expressions.
 * @module assemblyscript/expressions
 * @preferred
 */ /** */

export * from "./expressions/arrayliteral";
export * from "./expressions/as";
export * from "./expressions/binary";
export * from "./expressions/call";
export * from "./expressions/conditional";
export * from "./expressions/elementaccess";
export * from "./expressions/helpers/load";
export * from "./expressions/helpers/loadorstore";
export * from "./expressions/helpers/store";
export * from "./expressions/identifier";
export * from "./expressions/literal";
export * from "./expressions/new";
export * from "./expressions/omitted";
export * from "./expressions/parenthesized";
export * from "./expressions/postfixunary";
export * from "./expressions/prefixunary";
export * from "./expressions/propertyaccess";

import * as binaryen from "binaryen";
import Compiler from "./compiler";
import * as reflection from "./reflection";
import * as typescript from "./typescript";
import * as util from "./util";
import {
  compileArrayLiteral,
  compileAs,
  compileBinary,
  compileCall,
  compileConditional,
  compileElementAccess,
  compileIdentifier,
  compileLiteral,
  compileNew,
  compileParenthesized,
  compilePostfixUnary,
  compilePrefixUnary,
  compilePropertyAccess,
  compileOmitted,
  tryParseLiteral,
  tryParseArrayLiteral
} from "./expressions";

/** Compiles any supported expression. */
export function compile(compiler: Compiler, node: typescript.Expression, contextualType: reflection.Type): binaryen.Expression {
  const op = compiler.module;

  util.setReflectedType(node, contextualType);

  switch (node.kind) {

    case typescript.SyntaxKind.ParenthesizedExpression:
      return compileParenthesized(compiler, <typescript.ParenthesizedExpression>node, contextualType);

    case typescript.SyntaxKind.AsExpression:
      return compileAs(compiler, <typescript.AsExpression>node, contextualType);

    case typescript.SyntaxKind.BinaryExpression:
      return compileBinary(compiler, <typescript.BinaryExpression>node, contextualType);

    case typescript.SyntaxKind.PrefixUnaryExpression:
      return compilePrefixUnary(compiler, <typescript.PrefixUnaryExpression>node, contextualType);

    case typescript.SyntaxKind.PostfixUnaryExpression:
      return compilePostfixUnary(compiler, <typescript.PostfixUnaryExpression>node, contextualType);

    case typescript.SyntaxKind.Identifier:
      return compileIdentifier(compiler, <typescript.Identifier>node, contextualType);

    case typescript.SyntaxKind.PropertyAccessExpression:
      return compilePropertyAccess(compiler, <typescript.PropertyAccessExpression>node, contextualType);

    case typescript.SyntaxKind.ElementAccessExpression:
      return compileElementAccess(compiler, <typescript.ElementAccessExpression>node, contextualType);

    case typescript.SyntaxKind.ConditionalExpression:
      return compileConditional(compiler, <typescript.ConditionalExpression>node, contextualType);

    case typescript.SyntaxKind.CallExpression:
      return compileCall(compiler, <typescript.CallExpression>node/*, contextualType*/);

    case typescript.SyntaxKind.NewExpression:
      return compileNew(compiler, <typescript.NewExpression>node, contextualType);

    case typescript.SyntaxKind.ThisKeyword:
      if (compiler.currentFunction.isInstance && compiler.currentFunction.parent)
        util.setReflectedType(node, compiler.currentFunction.parent.type);
      else
        compiler.report(node, typescript.DiagnosticsEx.Identifier_0_is_invalid_in_this_context, "this");
      return op.getLocal(0, compiler.typeOf(compiler.uintptrType));

    case typescript.SyntaxKind.TrueKeyword:
    case typescript.SyntaxKind.FalseKeyword:
    case typescript.SyntaxKind.NullKeyword:
    case typescript.SyntaxKind.StringLiteral:
      return compileLiteral(compiler, <typescript.LiteralExpression>node, contextualType);

    case typescript.SyntaxKind.NumericLiteral:
      const parent = <typescript.Node>node.parent;
      return compileLiteral(compiler, <typescript.LiteralExpression>node, contextualType, parent.kind === typescript.SyntaxKind.PrefixUnaryExpression && (<typescript.PrefixUnaryExpression>parent).operator === typescript.SyntaxKind.MinusToken);

    case typescript.SyntaxKind.ArrayLiteralExpression:
      return compileArrayLiteral(compiler, <typescript.ArrayLiteralExpression>node, contextualType);

    case typescript.SyntaxKind.OmittedExpression:
      return compileOmitted(compiler, <typescript.OmittedExpression>node, contextualType);
  }

  compiler.report(node, typescript.DiagnosticsEx.Unsupported_node_kind_0_in_1, node.kind, "expressions.compile");
  util.setReflectedType(node, contextualType);
  return op.unreachable();
}

/** Evaluates any supported expression. Returns `null` if that's not possible. */
export function evaluate(node: typescript.Expression, contextualType: reflection.Type): number | Long | string | Array<number | Long | string | null> | null {

  // TODO: See https://github.com/dcodeIO/AssemblyScript/issues/100

  // A code search for "=== typescript.SyntaxKind.PrefixUnaryExpression" should yield any locations
  // where support for negation has been hard coded instead.

  switch (node.kind) {

    case typescript.SyntaxKind.ParenthesizedExpression:
      return evaluate((<typescript.ParenthesizedExpression>node).expression, contextualType);

    case typescript.SyntaxKind.PrefixUnaryExpression: {
      const expr = <typescript.PrefixUnaryExpression>node;
      if (expr.operator === typescript.SyntaxKind.MinusToken && expr.operand.kind === typescript.SyntaxKind.NumericLiteral)
        return tryParseLiteral(<typescript.NumericLiteral>expr.operand, contextualType, true);
      return null;
    }

    case typescript.SyntaxKind.NumericLiteral:
      if (!contextualType.isNumeric)
        return null;
      return tryParseLiteral(<typescript.NumericLiteral>node, contextualType);

    case typescript.SyntaxKind.StringLiteral:
      if (!contextualType.isString)
        return null;
      return tryParseLiteral(<typescript.StringLiteral>node, contextualType);

    case typescript.SyntaxKind.ArrayLiteralExpression:
      if (!contextualType.isArray)
        return null;
      return tryParseArrayLiteral(<typescript.ArrayLiteralExpression>node, contextualType);

  }
  return null;
}
