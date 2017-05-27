import { Compiler } from "../compiler";
import { intType } from "../types";
import { getWasmType } from "../util";
import { binaryen } from "../wasm";
import * as wasm from "../wasm";

export function compileWhile(compiler: Compiler, node: ts.WhileStatement, onVariable: (node: ts.VariableDeclaration) => number): binaryen.Statement {
  const op = compiler.module;
  const statement = compiler.compileStatement(node.statement, onVariable);

  compiler.enterBreakContext();

  const label = compiler.currentBreakLabel;
  const context = op.loop("break$" + label, op.block("continue$" + label, [
    op.break("break$" + label, op.i32.eqz(compiler.maybeConvertValue(node.expression, compiler.compileExpression(node.expression, intType), getWasmType(node.expression), intType, true))),
    statement || op.nop()
  ]));

  compiler.leaveBreakContext();

  return context;
}
