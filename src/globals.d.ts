// Replaced at build time from package.json (see `define` in vite.config.ts).
declare const __PACKAGE_HOMEPAGE__: string;
declare const __PACKAGE_LICENSE__: string;
// True when the build was given `--opcodes=<json>` and emits opcodes.html.
declare const __HAS_OPCODES__: boolean;

// The opcode list from the `--opcodes` JSON file (empty when it is not given).
declare module "virtual:opcodes" {
  export interface WasmOpcode {
    name: string;
    wat: string;
    code: number;
  }
  const opcodes: WasmOpcode[];
  export default opcodes;
}
