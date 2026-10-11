import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing application root");
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider locale="zh-TW">
      <App />
    </I18nProvider>
  </StrictMode>,
);

// Only the built application registers an app-shell worker; API responses are never cached.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      // Online use still works if the browser does not allow offline app-shell storage.
    });
  });
}
