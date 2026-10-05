import { Fragment, useMemo, useState } from "react";
import opcodes, { type WasmOpcode } from "virtual:opcodes";
import { AppFooter, AppHeader } from "./components/Layout";

// Prefixed opcodes from the libnetq list pack the prefix byte above the
// sub-opcode: 0xPPSS for sub-opcodes up to 0xff, 0xPPSSS above that.
interface DecodedOpcode extends WasmOpcode {
  prefix: number | null;
  sub: number;
  bytes: string;
}

const kPrefixNames: Record<number, string> = {
  0xfb: "GC",
  0xfc: "Misc",
  0xfd: "SIMD",
  0xfe: "Threads",
};

type GroupId = "all" | "core" | number;

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

// Sub-opcodes are encoded as unsigned LEB128.
function leb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0)
      byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function decode(opcode: WasmOpcode): DecodedOpcode {
  if (opcode.code <= 0xff)
    return { ...opcode, prefix: null, sub: opcode.code, bytes: hexByte(opcode.code) };

  const shift = opcode.code <= 0xffff ? 8 : 12;
  const prefix = opcode.code >>> shift;
  const sub = opcode.code & ((1 << shift) - 1);
  return { ...opcode, prefix, sub, bytes: [prefix, ...leb128(sub)].map(hexByte).join(" ") };
}

function groupLabel(prefix: number): string {
  return kPrefixNames[prefix] ?? "0x" + hexByte(prefix);
}

const kOpcodes = opcodes.map(decode);

interface OpcodeChart {
  id: GroupId;
  label: string;
  count: number;
  // Like an ASCII chart: one row per high part of the (sub-)opcode, one column
  // per low hex digit. Rows without any opcode are left out.
  rows: { high: number; cells: (DecodedOpcode | undefined)[] }[];
}

function buildChart(id: GroupId, label: string, items: DecodedOpcode[]): OpcodeChart {
  const rows = new Map<number, (DecodedOpcode | undefined)[]>();
  for (const item of items) {
    const high = item.sub >>> 4;
    let cells = rows.get(high);
    if (cells === undefined) {
      cells = new Array<DecodedOpcode | undefined>(16).fill(undefined);
      rows.set(high, cells);
    }
    cells[item.sub & 0xf] = item;
  }
  return {
    id,
    label,
    count: items.length,
    rows: [...rows.entries()].sort(([a], [b]) => a - b).map(([high, cells]) => ({ high, cells })),
  };
}

const kCharts: OpcodeChart[] = (() => {
  const prefixes = [...new Set(kOpcodes.flatMap((item) => (item.prefix === null ? [] : [item.prefix])))].sort((a, b) => a - b);
  return [
    buildChart("core", "Core", kOpcodes.filter((item) => item.prefix === null)),
    ...prefixes.map((prefix) => buildChart(prefix, `${groupLabel(prefix)} · 0x${hexByte(prefix)}`, kOpcodes.filter((item) => item.prefix === prefix))),
  ];
})();

const kTabs: { id: GroupId; label: string; count: number }[] = [
  { id: "all", label: "All", count: kOpcodes.length },
  ...kCharts.map(({ id, label, count }) => ({ id, label, count })),
];

const kColumns = Array.from({ length: 16 }, (_, index) => index.toString(16));

function matches(item: DecodedOpcode, needle: string): boolean {
  return `${item.wat} ${item.bytes} 0x${item.bytes.replace(/ /g, "")}`.toLowerCase().includes(needle);
}

// Lets long instruction names wrap after "." and "_" instead of mid-word.
function breakable(text: string) {
  return text.split(/(?<=[._])/).map((part, index) => (
    <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>
  ));
}

export function OpcodesApp() {
  const [group, setGroup] = useState<GroupId>("all");
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const charts = group === "all" ? kCharts : kCharts.filter((chart) => chart.id === group);
  const matched = useMemo(
    () => (needle === "" ? -1 : charts.reduce((sum, chart) => sum + chart.rows.reduce((rowSum, row) => rowSum + row.cells.filter((item) => item && matches(item, needle)).length, 0), 0)),
    [charts, needle],
  );

  return (
    <div className="app">
      <AppHeader page="opcodes" />

      <main className="app-main">
        <section className="summary">
          <h1 className="page-title">WebAssembly opcodes</h1>
          <div className="file-meta">
            <span>{kOpcodes.length} instructions</span>
            <span>{kCharts.length - 1} prefixes</span>
          </div>
        </section>

        <nav className="tabs" role="tablist">
          {kTabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={group === item.id}
              className={group === item.id ? "tab active" : "tab"}
              onClick={() => setGroup(item.id)}
            >
              {item.label}
              <span className="badge">{item.count}</span>
            </button>
          ))}
        </nav>

        <div className="tab-panel" role="tabpanel">
          <input
            className="filter"
            type="search"
            value={filter}
            placeholder="Filter by instruction or bytes"
            onChange={(event) => setFilter(event.target.value)}
          />
          {matched === 0 && <div className="muted small footer">No matches.</div>}
          {charts.map((chart) => (
            <section key={chart.id} className="opcode-chart">
              {group === "all" && <h2 className="chart-title">{chart.label}</h2>}
              <table className="grid opcode-map">
                <thead>
                  <tr>
                    <th className="row-label" />
                    {kColumns.map((column) => <th key={column}>_{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {chart.rows.map((row) => (
                    <tr key={row.high}>
                      <th className="row-label">{row.high.toString(16)}_</th>
                      {row.cells.map((item, index) => {
                        if (item === undefined)
                          return <td key={index} className="op-cell empty" />;
                        const dim = needle !== "" && !matches(item, needle);
                        return (
                          <td key={index} className={dim ? "op-cell dim" : "op-cell"} title={`${item.wat}\n${item.bytes}`}>
                            <div className="op-bytes">{item.bytes}</div>
                            <div className="op-wat">{breakable(item.wat)}</div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </main>

      <AppFooter />
    </div>
  );
}
