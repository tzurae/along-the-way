// @vitest-environment jsdom
import { createRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type {
  MustItemKind,
  TripPlaceMustItemDto,
  TripPlaceMustItemListResponse,
  TripPlaceMustItemResponse,
} from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "../src/api-error";
import { PlaceMustItems, type PlaceMustItemsHandle } from "../src/PlaceMustItems";

const tripId = "11111111-1111-4111-8111-111111111111";
const placeId = "22222222-2222-4222-8222-222222222222";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

type Request = <T>(path: string, options?: RequestOptions) => Promise<T>;

function item(id: number, label: string, kind: MustItemKind = "buy", version = 1): TripPlaceMustItemDto {
  return {
    id: `33333333-3333-4333-8333-${String(id).padStart(12, "0")}`,
    tripPlaceId: placeId,
    kind,
    label,
    version,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
}

function parsed<T>(value: unknown, options?: RequestOptions) {
  return (options?.parse ? options.parse(value) : value) as T;
}

function requestWith(initial: TripPlaceMustItemDto[], mutate?: Request): Request {
  return async <T,>(path: string, options?: RequestOptions) => {
    if (!options?.method) return parsed<T>({ items: initial } satisfies TripPlaceMustItemListResponse, options);
    if (mutate) return mutate<T>(path, options);
    throw new Error(`Unexpected request: ${path}`);
  };
}

beforeEach(() => {
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "44444444-4444-4444-8444-444444444444") });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("creates one default-buy draft, exposes saving state, announces success, and focuses its edit control", async () => {
  let resolveSave!: (value: TripPlaceMustItemResponse) => void;
  const mutation = vi.fn(<T,>(_path: string, options?: RequestOptions) => new Promise<T>((resolve) => {
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({ kind: "buy", label: "抹茶粉" });
    resolveSave = (value) => resolve(parsed<T>(value, options));
  })) as unknown as Request;
  render(<PlaceMustItems tripId={tripId} tripPlaceId={placeId} request={requestWith([], mutation)} />);

  const add = await screen.findByRole("button", { name: "新增" });
  fireEvent.click(add);
  let name = screen.getByRole("textbox", { name: "項目名稱" });
  expect(name).toHaveFocus();
  expect(screen.getByRole("radio", { name: "必買" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "必吃" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(add).toHaveFocus());
  fireEvent.click(add);
  name = screen.getByRole("textbox", { name: "項目名稱" });
  fireEvent.change(name, { target: { value: " 抹茶粉 " } });
  fireEvent.click(screen.getByRole("button", { name: "儲存" }));
  expect(await screen.findByRole("button", { name: "儲存中…" })).toBeDisabled();
  resolveSave({ item: item(1, "抹茶粉") });

  const edit = await screen.findByRole("button", { name: "編輯『抹茶粉』" });
  await waitFor(() => expect(edit).toHaveFocus());
  expect(screen.getByText("已新增『抹茶粉』")).toBeInTheDocument();
});

it("keeps the draft for length, duplicate, and network errors with the required copy", async () => {
  const failures = [
    new ApiRequestError("must_item_duplicate", "duplicate", undefined, undefined, undefined, 409),
    new ApiRequestError("unknown", "offline"),
  ];
  const mutation = vi.fn(async <T,>() => { throw failures.shift(); }) as Request;
  render(<PlaceMustItems tripId={tripId} tripPlaceId={placeId} request={requestWith([], mutation)} />);
  fireEvent.click(await screen.findByRole("button", { name: "新增" }));
  const name = screen.getByRole("textbox", { name: "項目名稱" });

  fireEvent.change(name, { target: { value: "長".repeat(81) } });
  fireEvent.click(screen.getByRole("button", { name: "儲存" }));
  expect(screen.getByRole("alert")).toHaveTextContent("名稱最多 80 個字");
  expect(mutation).not.toHaveBeenCalled();

  fireEvent.change(name, { target: { value: "豆大福" } });
  fireEvent.click(screen.getByRole("button", { name: "儲存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("這個項目已經在清單裡了");
  expect(name).toHaveValue("豆大福");

  fireEvent.click(screen.getByRole("button", { name: "儲存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("沒有儲存成功，請再試一次");
  expect(name).toHaveValue("豆大福");
});

it("accepts an 80-character name and hides categories without items", async () => {
  const label = "八".repeat(80);
  const mutation = (async <T,>(_path: string, options?: RequestOptions) => {
    expect(JSON.parse(String(options?.body)).label).toBe(label);
    return parsed<T>({ item: item(1, label) } satisfies TripPlaceMustItemResponse, options);
  }) as Request;
  render(<PlaceMustItems tripId={tripId} tripPlaceId={placeId} request={requestWith([], mutation)} />);
  fireEvent.click(await screen.findByRole("button", { name: "新增" }));
  fireEvent.change(screen.getByRole("textbox", { name: "項目名稱" }), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: "儲存" }));
  expect(await screen.findByText(label)).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 4, name: "必買" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { level: 4, name: "必吃" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { level: 4, name: "必喝" })).not.toBeInTheDocument();
});

it("loads the latest item or preserves the local draft after a version conflict", async () => {
  const original = item(1, "焙茶", "drink", 1);
  const latest = item(1, "冰焙茶", "drink", 2);
  let reads = 0;
  let writes = 0;
  const request: Request = async <T,>(_path: string, options?: RequestOptions) => {
    if (!options?.method) {
      reads += 1;
      return parsed<T>({ items: reads === 1 ? [original] : [latest] }, options);
    }
    writes += 1;
    if (writes === 1) throw new ApiRequestError("conflict", "conflict", undefined, 2, null, 409);
    const body = JSON.parse(String(options.body));
    expect(body).toEqual({ kind: "drink", label: "我的焙茶", expectedVersion: 2 });
    return parsed<T>({ item: { ...latest, label: "我的焙茶", version: 3 } }, options);
  };
  render(<PlaceMustItems tripId={tripId} tripPlaceId={placeId} request={request} />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯『焙茶』" }));
  const name = screen.getByRole("textbox", { name: "項目名稱" });
  fireEvent.change(name, { target: { value: "我的焙茶" } });
  fireEvent.click(screen.getByRole("button", { name: "儲存" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("其他成員剛改過這個項目");
  fireEvent.click(screen.getByRole("button", { name: "保留我的修改" }));
  expect(name).toHaveValue("我的焙茶");
  fireEvent.click(screen.getByRole("button", { name: "儲存" }));
  expect(await screen.findByRole("button", { name: "編輯『我的焙茶』" })).toBeInTheDocument();
});

it("confirms deletion inline, announces it, and returns focus to add", async () => {
  const existing = item(1, "御守");
  const mutation = vi.fn(async <T,>(_path: string, options?: RequestOptions) => {
    expect(options?.method).toBe("DELETE");
    expect(JSON.parse(String(options?.body))).toEqual({ expectedVersion: 1 });
    return null as T;
  }) as unknown as Request;
  render(<PlaceMustItems tripId={tripId} tripPlaceId={placeId} request={requestWith([existing], mutation)} />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯『御守』" }));
  fireEvent.click(screen.getByRole("button", { name: "移除項目" }));
  const confirmation = screen.getByRole("group", { name: "移除『御守』" });
  expect(within(confirmation).getByRole("button", { name: "保留" })).toBeInTheDocument();
  fireEvent.click(within(confirmation).getByRole("button", { name: "移除" }));
  const add = await screen.findByRole("button", { name: "新增" });
  await waitFor(() => expect(add).toHaveFocus());
  expect(screen.getByText("已移除『御守』")).toBeInTheDocument();
});

it("disables add at 24 items and guards sheet close only after the draft changes", async () => {
  const fullRequest = requestWith(Array.from({ length: 24 }, (_, index) => item(index + 1, `項目 ${index + 1}`)));
  const { unmount } = render(<PlaceMustItems tripId={tripId} tripPlaceId={placeId} request={fullRequest} />);
  expect(await screen.findByRole("button", { name: "新增" })).toBeDisabled();
  expect(screen.getByText("每個地點最多 24 項")).toBeInTheDocument();
  unmount();

  const handle = createRef<PlaceMustItemsHandle>();
  function GuardHarness() {
    const [closed, setClosed] = useState(false);
    if (closed) return <p>已關閉</p>;
    return <><button type="button" onClick={() => {
      if (handle.current?.requestClose(() => setClosed(true))) setClosed(true);
    }}>關閉 sheet</button><PlaceMustItems ref={handle} tripId={tripId} tripPlaceId={placeId} request={requestWith([])} /></>;
  }
  render(<GuardHarness />);
  fireEvent.click(await screen.findByRole("button", { name: "新增" }));
  fireEvent.change(screen.getByRole("textbox", { name: "項目名稱" }), { target: { value: "羊羹" } });
  fireEvent.click(screen.getByRole("button", { name: "關閉 sheet" }));
  const prompt = await screen.findByRole("dialog", { name: "要放棄還沒儲存的項目嗎？" });
  fireEvent.click(within(prompt).getByRole("button", { name: "繼續編輯" }));
  expect(screen.getByRole("textbox", { name: "項目名稱" })).toHaveValue("羊羹");
  fireEvent.click(screen.getByRole("button", { name: "關閉 sheet" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "要放棄還沒儲存的項目嗎？" })).getByRole("button", { name: "放棄" }));
  expect(await screen.findByText("已關閉")).toBeInTheDocument();
});
