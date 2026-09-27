import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TripSummaryPage } from "./TripSummaryPage";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing application root");
}

const slug =
  new URLSearchParams(window.location.search).get("trip") ??
  "hong-kong-together";

createRoot(root).render(
  <StrictMode>
    <TripSummaryPage slug={slug} />
  </StrictMode>,
);
