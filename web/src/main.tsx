import { createRoot } from "react-dom/client";

import { App } from "./app";
import { I18nProvider } from "./i18n";

import "./styles.css";

const el = document.getElementById("app");
if (el) {
  createRoot(el).render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}
