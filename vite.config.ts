import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `npm run build --base-url=/foo` and `npm run dev --base-url=/foo` expose the
// value to the script as the `npm_config_base_url` environment variable.
function normalizeBaseUrl(value: string | undefined): string {
  let base = (value ?? "").trim();
  if (!base.startsWith("/"))
    base = "/" + base;
  if (!base.endsWith("/"))
    base += "/";
  return base;
}

const baseUrl = normalizeBaseUrl(process.env.npm_config_base_url);

// Dev server forwards API calls to a running wasmview_server.
const serverUrl = process.env.npm_config_server_url ?? "http://localhost:8033";

// `npm run build --opcodes=<json>` adds opcodes.html, built from the list that
// the `opcodes` tool writes. A missing file only skips the page.
interface WasmOpcode {
  name: string;
  wat: string;
  code: number;
}

function isOpcode(value: unknown): value is WasmOpcode {
  if (typeof value !== "object" || value === null)
    return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && typeof item.wat === "string"
    && typeof item.code === "number" && Number.isInteger(item.code) && item.code >= 0;
}

function loadOpcodes(value: string | undefined): { file: string; opcodes: WasmOpcode[] } | null {
  if (value === undefined || value.trim() === "")
    return null;

  const file = resolve(value.trim());
  if (!existsSync(file)) {
    console.warn(`opcodes: ${file} does not exist, opcodes.html is not generated`);
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`opcodes: cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(data))
    throw new Error(`opcodes: ${file} must contain a JSON array`);
  const invalid = data.findIndex((item) => !isOpcode(item));
  if (invalid >= 0)
    throw new Error(`opcodes: ${file}: entry ${invalid} must have string "name" and "wat" and a non-negative integer "code"`);
  if (data.length === 0)
    throw new Error(`opcodes: ${file} has no opcodes`);

  return { file, opcodes: data };
}

const opcodes = loadOpcodes(process.env.npm_config_opcodes);

const kOpcodesModuleId = "virtual:opcodes";

// Serves the --opcodes list to src/OpcodesApp.tsx as `import opcodes from "virtual:opcodes"`.
function opcodesModule(): Plugin {
  const resolvedId = "\0" + kOpcodesModuleId;
  return {
    name: "wasmview-opcodes",
    resolveId(id) {
      return id === kOpcodesModuleId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId)
        return undefined;
      if (opcodes !== null)
        this.addWatchFile(opcodes.file);
      return `export default ${JSON.stringify(opcodes?.opcodes ?? [])};`;
    },
  };
}

const pages: Record<string, string> = {
  index: fileURLToPath(new URL("./src/index.html", import.meta.url)),
};
if (opcodes !== null)
  pages.opcodes = fileURLToPath(new URL("./src/opcodes.html", import.meta.url));

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const kMediaTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function mediaTypeOf(file: string): string | undefined {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? undefined : kMediaTypes[file.slice(dot)];
}

// Emits dist/manifest.json, which the wasmview_wla module reads to map URLs
// to the built client files (see NQWebManifestListenersInit).
function webManifest(publicFiles: string[]): Plugin {
  return {
    name: "wasmview-web-manifest",
    apply: "build",
    // writeBundle runs after Vite has added the HTML page and CSS to the bundle.
    writeBundle(options, bundle) {
      const files = [...Object.keys(bundle), ...publicFiles].sort();
      // Pages other than index.html are served without the extension, e.g.
      // opcodes.html at <base>opcodes.
      const fileEntries = files.map((file) => ({
        url: file === "index.html" ? baseUrl : baseUrl + file.replace(/\.html$/, ""),
        file,
        type: mediaTypeOf(file),
      }));
      // The entry point is the base URL without its trailing slash ("/123"),
      // except for the site root, which stays "/".
      const mainUrl = baseUrl === "/" ? baseUrl : baseUrl.slice(0, -1);
      if (mainUrl !== baseUrl)
        fileEntries.push({ url: mainUrl, file: "index.html", type: mediaTypeOf("index.html") });

      const manifest = {
        name: pkg.name,
        base: baseUrl,
        entries: [
          {
            main: mainUrl,
            title: "WASM View",
            version: pkg.version,
            description: pkg.description,
            icons: [{ url: baseUrl + "favicon.svg", colorScheme: "light" }],
            screenshots: [
              { url: baseUrl + "logo_wla.svg", colorScheme: "light" },
              { url: baseUrl + "logo_wla.svg", colorScheme: "dark" },
            ],
          },
        ],
        files: fileEntries,
      };

      writeFileSync(join(options.dir!, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  root: "src",
  base: baseUrl,
  publicDir: "public",
  plugins: [react(), opcodesModule(), webManifest(["favicon.svg", "logo_wla.svg"])],
  define: {
    __PACKAGE_HOMEPAGE__: JSON.stringify(pkg.homepage),
    __PACKAGE_LICENSE__: JSON.stringify(pkg.license),
    __HAS_OPCODES__: JSON.stringify(opcodes !== null),
  },
  server: {
    proxy: {
      [baseUrl + "modinfo"]: serverUrl,
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "",
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: {
      input: pages,
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "index-[name].js",
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith(".css")) ? "index.css" : "[name][extname]"),
      },
    },
  },
});
