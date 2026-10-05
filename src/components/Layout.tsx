import type { ReactNode } from "react";
import homeIconDark from "../assets/home_dark_hover.svg";
import homeIconLight from "../assets/home_light_hover.svg";

// Served under a sub-path, so offer a way back to the site root.
const kShowHome = import.meta.env.BASE_URL !== "/";

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
        <div className="brand">
          <img src={import.meta.env.BASE_URL + "favicon.svg"} alt="" width={28} height={28} />
          <span>WASM View</span>
        </div>
        {kShowHome && (
          <a className="home-button" href="/" title="Home" aria-label="Home">
            <picture>
              <source srcSet={homeIconLight} media="(prefers-color-scheme: dark)" />
              <img src={homeIconDark} alt="" width={30} height={28} />
            </picture>
          </a>
        )}
        {/* Each page links to the other one. */}
        {page === "opcodes" ? (
          <a className="header-link" href={import.meta.env.BASE_URL}>Modules</a>
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
