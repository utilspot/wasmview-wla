import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OpcodesApp } from "./OpcodesApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OpcodesApp />
  </StrictMode>,
);
