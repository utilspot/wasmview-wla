import { useCallback, useEffect, useRef, useState } from "react";
import { uploadModule, type WasmModuleInfo } from "./api";
import { UploadZone } from "./components/UploadZone";
import { ModuleView } from "./components/ModuleView";
import homeIconDark from "./assets/home_dark_hover.svg";
import homeIconLight from "./assets/home_light_hover.svg";

// Served under a sub-path, so offer a way back to the site root.
const kShowHome = import.meta.env.BASE_URL !== "/";

type State =
  | { status: "idle" }
  | { status: "loading"; fileName: string; loaded: number; total: number }
  | { status: "error"; fileName: string; message: string }
  | { status: "ready"; file: File; module: WasmModuleInfo };

export function App() {
  const [state, setState] = useState<State>({ status: "idle" });
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const openFile = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ status: "loading", fileName: file.name, loaded: 0, total: file.size });
    try {
      const module = await uploadModule(file, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (!controller.signal.aborted)
            setState({ status: "loading", fileName: file.name, loaded, total });
        },
      });
      setState({ status: "ready", file, module });
    } catch (error) {
      if (controller.signal.aborted)
        return;
      setState({ status: "error", fileName: file.name, message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The whole window accepts a dropped module, not just the upload zone.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event))
        return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0)
        setDragging(false);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event))
        event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file)
        void openFile(file);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [openFile]);

  return (
    <div className={dragging ? "app dragging" : "app"}>
      <header className="app-header">
        <div className="header-start">
          <a className="brand" href={import.meta.env.BASE_URL}>
            <img src={import.meta.env.BASE_URL + "favicon.svg"} alt="" width={28} height={28} />
            <span>WASM View</span>
          </a>
          {kShowHome && (
            <a className="home-button" href="/" title="Home" aria-label="Home">
              <picture>
                <source srcSet={homeIconLight} media="(prefers-color-scheme: dark)" />
                <img src={homeIconDark} alt="" width={30} height={28} />
              </picture>
            </a>
          )}
        </div>
        {state.status !== "idle" && <UploadZone compact onFile={openFile} />}
      </header>

      <main className="app-main">
        {state.status === "idle" && <UploadZone onFile={openFile} />}

        {state.status === "loading" && <UploadProgress fileName={state.fileName} loaded={state.loaded} total={state.total} />}

        {state.status === "error" && (
          <div className="notice error" role="alert">
            <strong>{state.fileName}</strong>: {state.message}
          </div>
        )}

        {state.status === "ready" && <ModuleView file={state.file} module={state.module} />}
      </main>

      <footer className="app-footer">
        Copyright © 2026 · {__PACKAGE_LICENSE__} · <a href={__PACKAGE_HOMEPAGE__} target="_blank" rel="noreferrer">GitHub</a>
      </footer>

      {dragging && <div className="drop-overlay">Drop a .wasm module to inspect it</div>}
    </div>
  );
}

function UploadProgress({ fileName, loaded, total }: { fileName: string; loaded: number; total: number }) {
  const uploaded = total === 0 || loaded >= total;
  const percent = total === 0 ? 100 : Math.min(100, Math.floor((loaded / total) * 100));

  return (
    <div className="notice upload-progress" aria-live="polite">
      <div className="upload-progress-label">
        {uploaded ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>Parsing <strong>{fileName}</strong>…</span>
          </>
        ) : (
          <span>Uploading <strong>{fileName}</strong></span>
        )}
        <span className="upload-progress-value">{uploaded ? `${total} bytes` : `${loaded} of ${total} bytes · ${percent}%`}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={uploaded ? "progress-bar done" : "progress-bar"} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
