import { createRoot } from "react-dom/client";

import { App } from "./app";

import "./styles.css";

const el = document.getElementById("app");
if (el) {
  createRoot(el).render(<App />);
}
