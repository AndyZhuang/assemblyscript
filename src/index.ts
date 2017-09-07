/**
 * The exported AssemblyScript namespace.
 *
 * <h4>Sub-namespaces</h4>
 * <ul style="margin: 0; padding: 0; list-style: none">
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/builtins|builtins}</li>
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/expressions|expressions}</li>
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/library|library}</li>
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/reflection|reflection}</li>
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/statements|statements}</li>
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/typescript|typescript}</li>
 *   <li class="tsd-kind-module"><span class="tsd-kind-icon" /> {@link assemblyscript/util|util}</li>
 * </ul>
 *
 * @module assemblyscript
 * @preferred
 */ /** */

import * as builtins from "./builtins";
import * as expressions from "./expressions";
import * as library from "./library";
import * as reflection from "./reflection";
import * as typescript from "./typescript";
import * as statements from "./statements";
import * as util from "./util";
import { Compiler, CompilerTarget } from "./compiler";
import { Memory } from "./memory";
import { Profiler } from "./profiler";

/** AssemblyScript version. */
export const version = library.version;

export {
  builtins,
  Compiler,
  CompilerTarget,
  expressions,
  library,
  Memory,
  Profiler,
  reflection,
  statements,
  typescript,
  util
};
