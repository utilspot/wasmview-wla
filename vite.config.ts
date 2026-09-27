import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
      const fileEntries = files.map((file) => ({
        url: file === "index.html" ? baseUrl : baseUrl + file,
        file,
        type: mediaTypeOf(file),
      }));
      if (baseUrl !== "/")
        fileEntries.push({ url: baseUrl.slice(0, -1), file: "index.html", type: mediaTypeOf("index.html") });

      const manifest = {
        name: pkg.name,
        base: baseUrl,
        entries: [
          {
            main: baseUrl,
            title: "WASM View",
            version: pkg.version,
            description: pkg.description,
            icons: [{ url: baseUrl + "favicon.svg", colorScheme: "light" }],
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
  plugins: [react(), webManifest(["favicon.svg"])],
  define: {
    __PACKAGE_HOMEPAGE__: JSON.stringify(pkg.homepage),
    __PACKAGE_LICENSE__: JSON.stringify(pkg.license),
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
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "index-[name].js",
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith(".css")) ? "index.css" : "[name][extname]"),
      },
    },
  },
});
