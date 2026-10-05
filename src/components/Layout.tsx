import type { ReactNode } from "react";

// Served under a sub-path, so offer a way back to the site root.
const kShowHome = import.meta.env.BASE_URL !== "/";

// The module page is served at the base URL without its trailing slash
// ("/123"), except for the site root, which stays "/".
const kMainUrl = kShowHome ? import.meta.env.BASE_URL.slice(0, -1) : "/";

export type PageId = "module" | "opcodes";

interface HeaderProps {
  page: PageId;
  // Placed at the end of the header, e.g. the compact upload button.
  children?: ReactNode;
}

export function AppHeader({ page, children }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="header-start">
        <a className="brand" href={kMainUrl}>
          <img src={import.meta.env.BASE_URL + "favicon.svg"} alt="" width={28} height={28} />
          <span>WASM View</span>
        </a>
        {kShowHome && <a className="header-link" href="/">Home</a>}
        {/* Each page links to the other one. */}
        {page === "opcodes" ? (
          <a className="header-link" href={kMainUrl}>Modules</a>
        ) : __HAS_OPCODES__ && (
          <a className="header-link" href={import.meta.env.BASE_URL + "opcodes"}>Opcodes</a>
        )}
      </div>
      {children}
    </header>
  );
}

export function AppFooter() {
  return (
    <footer className="app-footer">
      Copyright © 2026 · {__PACKAGE_LICENSE__} · <a href={__PACKAGE_HOMEPAGE__} target="_blank" rel="noreferrer">GitHub</a>
    </footer>
  );
}
