/** @module assemblyscript/reflection */ /** */

import Compiler from "../compiler";
import Type from "./type";

/** Flags describing the kind of a variable. */
export enum VariableFlags {
  /** No flags. */
  none = 0,
  /** Constant variable. */
  constant = 1 << 0,
  /** Global variable. */
  global = 1 << 1
}

/** A reflected variable. */
export class Variable {

  /** Compiler reference. */
  compiler: Compiler;
  /** Simple or global name, depending on context. */
  name: string;
  /** Reflected type. */
  type: Type;
  /** Flags. */
  flags: VariableFlags;
  /** Local index, if applicable. */
  index: number;
  /** Constant value, if applicable. */
  value?: number | Long;

  /** Constructs a new reflected variable. */
  constructor(compiler: Compiler, name: string, type: Type, flags: VariableFlags, index: number, value?: number | Long) {
    this.compiler = compiler;
    this.name = name;
    this.type = type;
    this.flags = flags;
    this.index = index;
    this.value = value;
  }

  /** Tests if this variable is declared constant. */
  get isConstant(): boolean { return (this.flags & VariableFlags.constant) !== 0; }
  /** Tests if this is a global variable. */
  get isGlobal(): boolean { return (this.flags & VariableFlags.global) !== 0; }
  /** Tests if this variable's value is inlined. */
  get isInlined(): boolean { return this.isConstant && this.value != null; }

  toString(): string { return this.name; }
}

export { Variable as default };
