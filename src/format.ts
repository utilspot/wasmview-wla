import { isFunctionImport, type WasmFuncType, type WasmModuleInfo } from "./api";

export function formatBytes(size: number): string {
  if (size < 1024)
    return `${size} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

export function formatSignature(type: WasmFuncType | undefined): string {
  if (!type)
    return "?";
  const results = type.results.length === 1 ? type.results[0] : `(${type.results.join(", ")})`;
  return `(${type.params.join(", ")}) → ${results}`;
}

export function formatLimits(min: number, max: number | undefined, unit: string): string {
  return max === undefined ? `${min}+ ${unit}` : `${min}–${max} ${unit}`;
}

// Functions share one index space: imported functions first, then the ones
// declared in the Function section.
export function functionTypeIndex(module: WasmModuleInfo, funcIndex: number): number | undefined {
  const imported = module.imports.filter(isFunctionImport);
  if (funcIndex < imported.length)
    return imported[funcIndex].type;
  return module.functions[funcIndex - imported.length];
}

export function formatOffset(offset: number): string {
  return "0x" + offset.toString(16).padStart(8, "0");
}

// `baseOffset` is the position of `bytes` in the file, used for the row labels.
export function hexDump(bytes: Uint8Array, baseOffset: number): string[] {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += 16) {
    const row = Array.from(bytes.subarray(start, start + 16));
    const hex = row.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = row.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${(baseOffset + start).toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines;
}
