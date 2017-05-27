import { Compiler } from "../compiler";
import * as Long from "long";
import { byteType, sbyteType, shortType, ushortType, intType, uintType, uintptrType32, longType, ulongType, uintptrType64, floatType, doubleType } from "../types";
import { setWasmType } from "../util";
import { binaryen } from "../wasm";
import * as wasm from "../wasm";

export function compilePropertyAccess(compiler: Compiler, node: ts.PropertyAccessExpression, contextualType: wasm.Type): binaryen.Expression {
  const op = compiler.module;

  // TODO: This currently only supports accessing constants in the form identifier.identifier (i.e. enum values)

  if (node.expression.kind === ts.SyntaxKind.Identifier) {
    const targetName = (<ts.Identifier>node.expression).text;

    if (node.name.kind === ts.SyntaxKind.Identifier) {
      const propertyName = (<ts.Identifier>node.name).text;
      const referencedConstant = compiler.constants[targetName + "$" + propertyName];

      if (referencedConstant) {
        switch (referencedConstant.type) {

          case byteType:
          case sbyteType:
          case shortType:
          case ushortType:
          case intType:
          case uintType:
          case uintptrType32:

            setWasmType(node, intType);
            return op.i32.const(referencedConstant.value);

          case longType:
          case ulongType:
          case uintptrType64:

            const long = Long.fromValue(referencedConstant.value);
            setWasmType(node, longType);
            return op.i64.const(long.low, long.high);

          case floatType:

            setWasmType(node, floatType);
            return op.f32.const(referencedConstant.value);

          case doubleType:

            setWasmType(node, doubleType);
            return op.f64.const(referencedConstant.value);

        }
      }
    }
  }

  compiler.error(node, "Unsupported property access");
  setWasmType(node, contextualType);
  return op.unreachable();
}
