import { useEffect, useMemo, useState } from "react";
import { isFunctionImport, type WasmExport, type WasmImport, type WasmModuleInfo, type WasmSection } from "../api";
import { formatBytes, formatLimits, formatOffset, formatSignature, functionTypeIndex, hexDump } from "../format";

const kHexDumpLimit = 4096;

const kRowLimit = 1000;

type TabId = "sections" | "types" | "imports" | "functions" | "exports";

interface Props {
  file: File;
  module: WasmModuleInfo;
}

export function ModuleView({ file, module }: Props) {
  const [tab, setTab] = useState<TabId>("sections");

  const importedFunctions = module.imports.filter(isFunctionImport).length;
  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: "sections", label: "Sections", count: module.sections.length },
    { id: "types", label: "Types", count: module.types.length },
    { id: "imports", label: "Imports", count: module.imports.length },
    { id: "functions", label: "Functions", count: importedFunctions + module.functions.length },
    { id: "exports", label: "Exports", count: module.exports.length },
  ];

  return (
    <div className="module">
      <section className="summary">
        <h1 className="file-name">{file.name}</h1>
        <div className="file-meta">
          <span>{formatBytes(module.size)}</span>
          <span>Version {module.version}</span>
        </div>
      </section>

      <nav className="tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "tab active" : "tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            <span className="badge">{item.count}</span>
          </button>
        ))}
      </nav>

      <div className="tab-panel" role="tabpanel">
        {tab === "sections" && <SectionsTable file={file} sections={module.sections} />}
        {tab === "types" && <TypesTable module={module} />}
        {tab === "imports" && <ImportsTable module={module} />}
        {tab === "functions" && <FunctionsTable module={module} />}
        {tab === "exports" && <ExportsTable module={module} />}
      </div>
    </div>
  );
}

function SectionsTable({ file, sections }: { file: File; sections: WasmSection[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="num">#</th>
          <th className="num">ID</th>
          <th>Section</th>
          <th className="num">Offset</th>
          <th className="num">Size</th>
          <th className="num">Items</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((section, index) => {
          const open = expanded === index;
          return (
            <SectionRow
              key={index}
              index={index}
              file={file}
              section={section}
              open={open}
              onToggle={() => setExpanded(open ? null : index)}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function SectionRow({ index, file, section, open, onToggle }: { index: number; file: File; section: WasmSection; open: boolean; onToggle: () => void }) {
  const canExpand = section.size > 0;

  return (
    <>
      <tr className={canExpand ? "clickable" : undefined} onClick={canExpand ? onToggle : undefined} aria-expanded={canExpand ? open : undefined}>
        <td className="num muted">{index}</td>
        <td className="num">{section.id}</td>
        <td>
          {canExpand && <span className={open ? "caret open" : "caret"} aria-hidden="true" />}
          {section.name}
        </td>
        <td className="num code">{formatOffset(section.offset)}</td>
        <td className="num">{formatBytes(section.size)}</td>
        <td className="num">{section.count ?? ""}</td>
        <td className="code">{section.customName ?? ""}</td>
      </tr>
      {open && (
        <tr className="hex-row">
          <td colSpan={7}>
            <HexPreview file={file} offset={section.offset} size={section.size} />
          </td>
        </tr>
      )}
    </>
  );
}

// Reads the section payload from the local copy of the uploaded file.
function HexPreview({ file, offset, size }: { file: File; offset: number; size: number }) {
  const length = Math.min(size, kHexDumpLimit);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);
    file
      .slice(offset, offset + length)
      .arrayBuffer()
      .then((buffer) => {
        if (!cancelled)
          setBytes(new Uint8Array(buffer));
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [file, offset, length]);

  if (error)
    return <div className="muted small">Cannot read the file: {error}</div>;
  if (!bytes)
    return <div className="muted small">Reading…</div>;

  return (
    <>
      <pre className="hex">{hexDump(bytes, offset).join("\n")}</pre>
      {length < size && <div className="muted small">Showing the first {length} of {size} bytes.</div>}
    </>
  );
}

function TypesTable({ module }: { module: WasmModuleInfo }) {
  return (
    <>
      {!module.typesComplete && <div className="notice small">Only plain function types are decoded; the list stops at the first GC or recursive type.</div>}
      <table className="grid">
        <thead>
          <tr>
            <th className="num">Index</th>
            <th>Params</th>
            <th>Results</th>
          </tr>
        </thead>
        <tbody>
          {module.types.map((type, index) => (
            <tr key={index}>
              <td className="num muted">{index}</td>
              <td className="code">{type.params.join(" ") || "—"}</td>
              <td className="code">{type.results.join(" ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {module.types.length === 0 && <Empty />}
    </>
  );
}

function describeImport(module: WasmModuleInfo, item: WasmImport): string {
  switch (item.kind) {
  case "function":
    return `type ${item.type}  ${formatSignature(module.types[item.type])}`;
  case "table":
    return `${item.elemType}, min ${item.min}, max ${item.max}`;
  case "memory":
    return formatLimits(item.min, item.max, "pages") + (item.shared ? ", shared" : "") + (item.memory64 ? ", 64-bit" : "");
  case "global":
    return (item.mutable ? "mut " : "") + item.valType;
  }
}

function ImportsTable({ module }: { module: WasmModuleInfo }) {
  const [filter, setFilter] = useState("");
  const rows = useFiltered(module.imports, filter, (item) => `${item.module}.${item.name}`);

  return (
    <>
      <Filter value={filter} onChange={setFilter} placeholder="Filter imports" />
      <table className="grid">
        <thead>
          <tr>
            <th>Module</th>
            <th>Name</th>
            <th>Kind</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.items.map(({ item, index }) => (
            <tr key={index}>
              <td className="code">{item.module}</td>
              <td className="code">{item.name}</td>
              <td><KindTag kind={item.kind} /></td>
              <td className="code">{describeImport(module, item)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <RowsFooter shown={rows.items.length} matched={rows.matched} total={module.imports.length} />
    </>
  );
}

function FunctionsTable({ module }: { module: WasmModuleInfo }) {
  const [filter, setFilter] = useState("");

  const functions = useMemo(() => {
    const exportNames = new Map<number, string[]>();
    for (const item of module.exports) {
      if (item.kind !== "function")
        continue;
      exportNames.set(item.index, [...(exportNames.get(item.index) ?? []), item.name]);
    }

    const imports = module.imports.filter(isFunctionImport);
    const total = imports.length + module.functions.length;
    return Array.from({ length: total }, (_, funcIndex) => {
      const imported = funcIndex < imports.length ? imports[funcIndex] : undefined;
      const typeIndex = functionTypeIndex(module, funcIndex);
      return {
        funcIndex,
        typeIndex,
        name: imported ? `${imported.module}.${imported.name}` : undefined,
        exports: exportNames.get(funcIndex) ?? [],
      };
    });
  }, [module]);

  const rows = useFiltered(functions, filter, (item) => [String(item.funcIndex), item.name ?? "", ...item.exports].join(" "));

  return (
    <>
      <Filter value={filter} onChange={setFilter} placeholder="Filter by index, import or export name" />
      <table className="grid">
        <thead>
          <tr>
            <th className="num">Index</th>
            <th className="num">Type</th>
            <th>Signature</th>
            <th>Import / Export</th>
          </tr>
        </thead>
        <tbody>
          {rows.items.map(({ item }) => (
            <tr key={item.funcIndex}>
              <td className="num muted">{item.funcIndex}</td>
              <td className="num">{item.typeIndex ?? "?"}</td>
              <td className="code">{formatSignature(item.typeIndex !== undefined ? module.types[item.typeIndex] : undefined)}</td>
              <td className="code">
                {item.name && <span className="tag import">import</span>}
                {item.name}
                {item.exports.map((name) => (
                  <span key={name} className="export-name"><span className="tag export">export</span>{name}</span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <RowsFooter shown={rows.items.length} matched={rows.matched} total={functions.length} />
    </>
  );
}

function describeExport(module: WasmModuleInfo, item: WasmExport): string {
  if (item.kind !== "function")
    return "";
  const typeIndex = functionTypeIndex(module, item.index);
  return formatSignature(typeIndex !== undefined ? module.types[typeIndex] : undefined);
}

function ExportsTable({ module }: { module: WasmModuleInfo }) {
  const [filter, setFilter] = useState("");
  const rows = useFiltered(module.exports, filter, (item) => item.name);

  return (
    <>
      <Filter value={filter} onChange={setFilter} placeholder="Filter exports" />
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th className="num">Index</th>
            <th>Signature</th>
          </tr>
        </thead>
        <tbody>
          {rows.items.map(({ item, index }) => (
            <tr key={index}>
              <td className="code">{item.name}</td>
              <td><KindTag kind={item.kind} /></td>
              <td className="num">{item.index}</td>
              <td className="code">{describeExport(module, item)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <RowsFooter shown={rows.items.length} matched={rows.matched} total={module.exports.length} />
    </>
  );
}

function useFiltered<T>(items: T[], filter: string, text: (item: T) => string) {
  return useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => needle === "" || text(item).toLowerCase().includes(needle));
    return { items: matched.slice(0, kRowLimit), matched: matched.length };
    // `text` is a pure accessor recreated on each render, so it is not a dependency.
  }, [items, filter]);
}

function Filter({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <input className="filter" type="search" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

function RowsFooter({ shown, matched, total }: { shown: number; matched: number; total: number }) {
  if (total === 0)
    return <Empty />;
  if (matched === 0)
    return <div className="muted small footer">No matches.</div>;
  if (shown < matched)
    return <div className="muted small footer">Showing {shown} of {matched} matching rows. Refine the filter to see more.</div>;
  return null;
}

function KindTag({ kind }: { kind: string }) {
  return <span className={`tag kind-${kind}`}>{kind}</span>;
}

function Empty() {
  return <div className="muted small footer">This module has none.</div>;
}
