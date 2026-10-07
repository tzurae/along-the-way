// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConflictPanel } from "../src/ConflictPanel";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function compare(base: Record<string, unknown>, current: Record<string, unknown>) {
  await act(async () => root.render(<ConflictPanel
    conflict={{ base: { input: base, version: 1 }, current: { input: current, version: 2 }, attempted: base, latestChange: null }}
    busy={false} onAccept={() => {}} onReapply={() => {}} onEdit={() => {}}
  />));
  return [...host.querySelectorAll("dd p")].map((value) => value.textContent);
}

it.each([
  ["notes", (value: string) => ({ notes: value })],
  ["place names", (value: string) => ({ name: value })],
  ["brief text", (value: string) => ({ originalText: value })],
  ["feedback summaries", (value: string) => ({ interpretation: { summary: value } })],
  ["transport descriptions", (value: string) => ({ details: { mode: value } })],
  ["confirmation descriptions", (value: string) => ({ details: { confirmationStatus: value } })],
] as const)("preserves %s verbatim when text matches an enum catalog key", async (_label, input) => {
  expect(await compare(input("walking"), input("步行"))).toEqual(["walking", "步行", "walking"]);
});

it("still localizes typed enum fields in three-way comparisons", async () => {
  expect(await compare(
    { type: "activity", endpoints: [{ role: "start" }], constraints: [{ status: "unknown" }] },
    { type: "restaurant", endpoints: [{ role: "end" }], constraints: [{ status: "confirmed" }] },
  )).toEqual(["活動", "餐廳", "活動", "開始", "結束", "開始", "未確認", "已確認", "未確認"]);
});
