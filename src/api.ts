// `offset` and `size` locate the section payload in the uploaded file; the
// bytes themselves are read from the local file, not sent by the server.
export interface WasmSection {
  id: number;
  name: string;
  offset: number;
  size: number;
  count?: number;
  customName?: string;
}

export interface WasmFuncType {
  params: string[];
  results: string[];
}

interface WasmImportBase {
  module: string;
  name: string;
}

export type WasmImport = WasmImportBase & (
  | { kind: "function"; type: number }
  | { kind: "table"; elemType: string; min: number; max: number }
  | { kind: "memory"; min: number; max?: number; shared: boolean; memory64: boolean }
  | { kind: "global"; valType: string; mutable: boolean }
);

export type WasmFunctionImport = Extract<WasmImport, { kind: "function" }>;

export function isFunctionImport(item: WasmImport): item is WasmFunctionImport {
  return item.kind === "function";
}

export interface WasmMemory {
  min: number;
  max?: number;
  shared: boolean;
  memory64: boolean;
}

export interface WasmExport {
  name: string;
  kind: "function" | "table" | "memory" | "global" | "tag";
  index: number;
}

export interface WasmModuleInfo {
  size: number;
  version: number;
  sections: WasmSection[];
  types: WasmFuncType[];
  typesComplete: boolean;
  imports: WasmImport[];
  functions: number[];
  memories: WasmMemory[];
  exports: WasmExport[];
  start?: number;
}

export const kModuleUrl = import.meta.env.BASE_URL + "modinfo";

export interface UploadOptions {
  signal?: AbortSignal;
  // Called as the request body is sent; `loaded` reaches `total` once the
  // whole file is uploaded and the server starts parsing it.
  onProgress?: (loaded: number, total: number) => void;
}

// XMLHttpRequest is used instead of fetch because only it reports upload progress.
export function uploadModule(file: File, { signal, onProgress }: UploadOptions = {}): Promise<WasmModuleInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", kModuleUrl);
    xhr.setRequestHeader("Content-Type", "application/wasm");
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.upload.onload = () => onProgress?.(file.size, file.size);

    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(xhr.status >= 200 && xhr.status < 300 ? "The server returned an invalid response" : `Server error ${xhr.status}`));
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        const message = (body as { error?: string }).error;
        reject(new Error(message ?? `Server error ${xhr.status}`));
        return;
      }
      resolve(body as WasmModuleInfo);
    };
    xhr.onerror = () => reject(new Error("Network error while uploading the file"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  });
}
