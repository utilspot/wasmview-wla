import { useRef } from "react";

interface Props {
  compact?: boolean;
  onFile: (file: File) => void;
}

export function UploadZone({ compact, onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept=".wasm,application/wasm"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file)
          onFile(file);
      }}
    />
  );

  if (compact) {
    return (
      <>
        <button type="button" className="button" onClick={() => inputRef.current?.click()}>
          Open module…
        </button>
        {input}
      </>
    );
  }

  return (
    <button type="button" className="upload-zone" onClick={() => inputRef.current?.click()}>
      <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
        <path d="M12 16V4m0 0-5 5m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="upload-title">Drop a WebAssembly module here</span>
      <span className="upload-hint">or click to choose a .wasm file</span>
      {input}
    </button>
  );
}
