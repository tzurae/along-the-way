// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { PlacePhotoDto } from "@along-the-way/contracts/place-details";
import { DiscoveryWorkspace } from "../src/DiscoveryWorkspace";
import { AppToaster } from "../src/AppToaster";
import type { PlaceDetailRequestOptions } from "../src/PlaceThumbnail";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const trip: TripDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "京都家庭旅行",
  startDate: "2026-11-03",
  endDate: "2026-11-09",
  defaultCurrency: "JPY",
  countryStops: [{ id: "44444444-4444-4444-8444-444444444444", countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" }],
  days: [{ id: "55555555-5555-4555-8555-555555555555", date: "2026-11-03", title: null }],
  members: [],
  invites: [],
  memberCount: 2,
  dayCount: 1,
  role: "owner",
  version: 1,
  editorsCanSchedule: false,
};

const proposal = {
  id: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  providerPlaceId: "ChIJ-Nishiki",
  name: "錦市場",
  type: "activity",
  address: null,
  latitude: null,
  longitude: null,
  sourceUrl: null,
  recommendation: "適合安排成輕鬆的市場散步。",
  recommendationSentences: null,
  matchedNeeds: ["在地美食"],
  tradeoffs: [],
  tradeoffSentences: null,
  unknowns: [],
  status: "pending",
  evidence: [],
  voters: [],
  voteCount: 0,
  ownVote: false,
  votingAvailable: true,
  acceptedTripPlaceId: null,
  version: 1,
  category: "市場",
  endorsements: [],
};

const previewPhoto: PlacePhotoDto = {
  source: "curated",
  id: "nishiki-market",
  title: "錦市場",
  description: "錦市場入口",
  sourceName: "Wikimedia Commons",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Nishiki_Market.jpg",
  fileSourceUrl: "https://upload.wikimedia.org/nishiki-market.jpg",
  author: "市場攝影者",
  authorUrl: null,
  creditText: "錦市場，市場攝影者",
  licenseName: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  capturedAt: null,
  checkedAt: "2026-10-18T00:00:00Z",
  verificationUrl: "https://commons.wikimedia.org/w/index.php?title=File:Nishiki_Market.jpg&oldid=1234",
  locationEvidence: "作品頁標示錦市場。",
  changes: "縮圖裁切。",
  notices: [],
  originalWidth: 1200,
  originalHeight: 800,
  imageUrl: `/api/trips/${trip.id}/place-photo-assets/${"a".repeat(64)}.jpg?kind=proposal&id=${proposal.id}`,
  thumbnailUrl: `/api/trips/${trip.id}/place-photo-assets/${"b".repeat(64)}.jpg?kind=proposal&id=${proposal.id}`,
  width: 1200,
  height: 800,
};

beforeEach(() => {
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  render(<AppToaster />);
});

/** Undo steps for properties a test replaced on window or navigator. */
const restorers: Array<() => void> = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const restore of restorers.splice(0).reverse()) restore();
});

function replaceProperty(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

it("renders proposal behavior in the compact shared row without exposing the address", async () => {
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) {
      value = { discovery: {
        brief: null,
        latestRun: null,
        proposals: [proposal],
        decided: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      } };
    } else if (path.endsWith("/trip-places")) {
      value = { tripPlaces: [] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{ reference: { kind: "proposal", id: proposal.id }, photo: null, photoCount: 0 }] };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  const { container } = render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />);
  await screen.findByRole("heading", { name: "幫我找" });

  const row = await waitFor(() => {
    const element = container.querySelector<HTMLElement>('[data-place-list-row][data-discovery-proposal="錦市場"]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect(row).toHaveTextContent("適合安排成輕鬆的市場散步。");
  expect(row).toHaveTextContent("待討論");
  expect(row).not.toHaveTextContent("地址未知");
  expect(row.querySelectorAll(".pd-vote-control")).toHaveLength(1);
  expect(within(row).getByRole("button", { name: "不要再推薦" })).toBeVisible();
  // AI 建議 go only into the itinerary; there is no path into 口袋名單.
  expect(within(row).queryByRole("button", { name: "加入口袋名單" })).not.toBeInTheDocument();
});

it("renders an unsafe discovery citation as text instead of an external link", async () => {
  const unsafe = {
    ...proposal,
    recommendationSentences: [{ text: "市場適合散步。", evidenceIds: ["evidence-1"] }],
    evidence: [{
      id: "evidence-1",
      kind: "web-source",
      providerPlaceId: null,
      sourceUrl: "javascript:alert(document.domain)",
      title: "未受信任來源",
      attribution: "Web",
      observedAt: "2026-10-17T00:00:00Z",
      expiresAt: null,
      isStale: false,
    }],
  };
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) value = { discovery: { brief: null, latestRun: null, proposals: [unsafe], decided: [], modelAvailable: true, placeProviderAvailable: true } };
    else if (path.endsWith("/trip-places")) value = { tripPlaces: [] };
    else if (path.includes("/place-previews?")) value = { previews: [] };
    else if (path.includes("/place-details?")) value = { detail: {
      reference: { kind: "proposal", id: proposal.id }, canonicalPlaceId: null, name: proposal.name,
      asOfDate: null, sections: [], sources: [], photos: [], googlePhotos: [],
      photosUnavailable: false,
    } };
    else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />);
  await waitFor(() => expect(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)!);
  const detail = await screen.findByRole("dialog", { name: proposal.name });
  const citation = within(detail).getByText("[1]");
  expect(citation.tagName).toBe("SPAN");
  expect(detail.querySelector('a[href^="javascript:"]')).toBeNull();
});

it("shows an accepted proposal's detail as reasons then location, without wishlist-only sections", async () => {
  const acceptedPlaceId = "66666666-6666-4666-8666-666666666666";
  const accepted = { ...proposal, status: "accepted", acceptedTripPlaceId: acceptedPlaceId };
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) {
      value = { discovery: {
        brief: null,
        latestRun: null,
        proposals: [accepted],
        decided: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      } };
    } else if (path.endsWith("/trip-places")) {
      value = { tripPlaces: [] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{ reference: { kind: "proposal", id: proposal.id }, photo: null, photoCount: 0 }] };
    } else if (path.includes("/place-details?")) {
      value = { detail: {
        reference: { kind: "proposal", id: proposal.id },
        canonicalPlaceId: null,
        name: proposal.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [],
        photosUnavailable: false,
      } };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />);
  await waitFor(() => expect(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)!);
  const detail = await screen.findByRole("dialog", { name: "錦市場" });
  expect(within(detail).queryByText("豆乳甜甜圈")).not.toBeInTheDocument();
  expect(within(detail).queryByRole("link", { name: "到口袋名單查看或新增" })).not.toBeInTheDocument();

  const headings = within(detail).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
  expect(headings).toEqual(expect.arrayContaining(["推薦重點", "地點"]));
  expect(headings.indexOf("推薦重點")).toBeLessThan(headings.indexOf("地點"));
  // Empty cautions and the article-style evidence section are not rendered.
  expect(headings).not.toEqual(expect.arrayContaining(["必買／必吃／必喝"]));
  expect(headings).not.toEqual(expect.arrayContaining(["需要注意"]));
  expect(headings).not.toEqual(expect.arrayContaining(["佐證與景點資訊"]));
});

it("opens proposal thumbnails during normal and selection modes with licensed row attribution", async () => {
  const selectableProposal = { ...proposal, latitude: 35.005, longitude: 135.765 };
  const requestWithPhoto = (photo: PlacePhotoDto) => async <T,>(
    path: string,
    init?: PlaceDetailRequestOptions,
  ): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) {
      value = { discovery: {
        brief: null,
        latestRun: null,
        proposals: [selectableProposal],
        decided: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      } };
    } else if (path.endsWith("/trip-places")) {
      value = { tripPlaces: [] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{
        reference: { kind: "proposal", id: selectableProposal.id },
        photo,
        photoCount: 1,
      }] };
    } else if (path.includes("/place-details?")) {
      value = { detail: {
        reference: { kind: "proposal", id: selectableProposal.id },
        canonicalPlaceId: null,
        name: selectableProposal.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [],
        photosUnavailable: false,
      } };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  const rendered = render(
    <DiscoveryWorkspace accountId="account" trip={trip} request={requestWithPhoto(previewPhoto)} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />,
  );
  const row = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(`[data-discovery-proposal="${selectableProposal.name}"]`);
    expect(element?.querySelector("img")).toBeInTheDocument();
    return element!;
  });
  expect(row.querySelector(".place-photo-credit")).toHaveTextContent("市場攝影者・CC BY-SA 4.0");

  fireEvent.click(row.querySelector(".list-place-row__media")!);
  let detail = await screen.findByRole("dialog", { name: selectableProposal.name });
  fireEvent.click(within(detail).getByRole("button", { name: "關閉" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: selectableProposal.name })).not.toBeInTheDocument());

  // The row has its own 排入行程; the page-level one starts selection mode.
  fireEvent.click(screen.getAllByRole("button", { name: "排入行程" }).find((button) => !row.contains(button))!);
  expect(screen.getByRole("heading", { name: "已選 0 個地點" })).toBeInTheDocument();
  fireEvent.click(row.querySelector(".list-place-row__media")!);
  detail = await screen.findByRole("dialog", { name: selectableProposal.name });
  expect(detail).toBeInTheDocument();
  rendered.unmount();
});

it("updates a discovery vote immediately, blocks a double tap, never lets a late vote response undo a decision, and confirms with a fresh read", async () => {
  const discovery = {
    brief: null,
    latestRun: null,
    proposals: [proposal],
    decided: [],
    modelAvailable: true,
    placeProviderAvailable: true,
  };
  // While the vote is in flight another owner accepts the proposal; a refresh carries that.
  const accepted = { ...proposal, status: "accepted" as const, version: proposal.version + 1 };
  const concurrentRead = deferred<{ discovery: typeof discovery }>();
  const confirmedRead = deferred<{ discovery: typeof discovery }>();
  const voteResponse = deferred<{ proposal: typeof proposal }>();
  let discoveryReads = 0;
  let voteRequests = 0;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/discovery") && !init?.method) {
      discoveryReads += 1;
      const value = discoveryReads === 1 ? { discovery }
        : discoveryReads === 2 ? await concurrentRead.promise
        : await confirmedRead.promise;
      return (init?.parse ? init.parse(value) : value) as T;
    }
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [] } as T;
    if (path.includes("/place-previews?")) return { previews: [] } as T;
    if (path.endsWith(`/${proposal.id}/vote`) && init?.method === "PUT") {
      voteRequests += 1;
      const value = await voteResponse.promise;
      return (init.parse ? init.parse(value) : value) as T;
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const rendered = render(
    <DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />,
  );
  const button = await screen.findByRole("button", { name: "想去，0 票" });
  rendered.rerender(
    <DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={1} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />,
  );
  await waitFor(() => expect(discoveryReads).toBe(2));

  fireEvent.click(button);
  fireEvent.click(button);

  expect(voteRequests).toBe(1);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAccessibleName("已表態想去，1 票");
  expect(button).toBeDisabled();
  expect(screen.getByText("已選擇「錦市場」想去，正在儲存")).toBeInTheDocument();

  await act(async () => concurrentRead.resolve({ discovery: { ...discovery, proposals: [accepted] } }));
  expect(await screen.findByText("已選進行程・待排日期")).toBeInTheDocument();

  // The vote committed before the acceptance, so its response still says pending.
  await act(async () => voteResponse.resolve({ proposal: { ...proposal, ownVote: true, voteCount: 1 } }));
  await waitFor(() => expect(discoveryReads).toBe(3));
  expect(screen.getByText("已選進行程・待排日期")).toBeInTheDocument();
  expect(screen.queryByText("待討論")).not.toBeInTheDocument();

  await act(async () => confirmedRead.resolve({ discovery: { ...discovery, proposals: [{ ...accepted, ownVote: true, voteCount: 1 }] } }));
  expect(screen.getByText("已選進行程・待排日期")).toBeInTheDocument();
  expect(screen.queryByText("待討論")).not.toBeInTheDocument();
});

it("restores a failed discovery vote, announces the exact error, and reuses its idempotency key", async () => {
  const discovery = {
    brief: null,
    latestRun: null,
    proposals: [proposal],
    decided: [],
    modelAvailable: true,
    placeProviderAvailable: true,
  };
  const failedVote = deferred<never>();
  const idempotencyKeys: string[] = [];
  let voteRequests = 0;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery") && !init?.method) value = { discovery };
    else if (path.endsWith("/trip-places") && !init?.method) value = { tripPlaces: [] };
    else if (path.includes("/place-previews?")) value = { previews: [] };
    else if (path.endsWith(`/${proposal.id}/vote`) && init?.method === "PUT") {
      voteRequests += 1;
      idempotencyKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      if (voteRequests === 1) return await failedVote.promise;
      value = { proposal: { ...proposal, ownVote: true, voteCount: 1 } };
    } else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={vi.fn()} />);
  const button = await screen.findByRole("button", { name: "想去，0 票" });
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-pressed", "true");
  await act(async () => failedVote.reject(new Error("offline")));

  await waitFor(() => expect(button).not.toBeDisabled());
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(button).toHaveAccessibleName("想去，0 票");
  expect(screen.getByRole("alert")).toHaveTextContent("無法更新「錦市場」的想去狀態；已恢復原狀，請再試一次。");

  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
  expect(voteRequests).toBe(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});

const stages = (done: string[], running: string | null) => Object.fromEntries(
  ["plan", "discover", "research", "verify", "save", "photos"].map((stage) => [stage, {
    state: done.includes(stage) ? "done" : stage === running ? "running" : "pending",
    startedAt: done.includes(stage) || stage === running ? "2026-10-19T10:00:00.000Z" : null,
    endedAt: done.includes(stage) ? "2026-10-19T10:00:05.000Z" : null,
  }]),
);

function job(overrides: Record<string, unknown>) {
  return {
    id: "66666666-6666-4666-8666-666666666666", briefVersion: 1, status: "running", stage: "plan",
    stages: stages([], "plan"), errorCode: null, addedCount: null,
    createdAt: "2026-10-19T10:00:00.000Z", finishedAt: null, acknowledged: false, ...overrides,
  };
}

const brief = { version: 1, originalText: "京都 寺廟", structured: null, questionAnswers: [], unresolvedQuestions: [], updatedAt: "2026-10-19T09:00:00.000Z" };
const checklist = (status: "asking" | "ready", answer: string | null, version: number) => ({
  briefVersion: 1, status, maxFollowUps: 2, version,
  items: [{
    id: "q1", text: "想看紅葉嗎？", why: "決定要不要排賞楓的寺。", options: ["想", "不用"], allowOther: false, multiple: false,
    required: true, answer, skipped: false, verdict: answer ? "sufficient" : null, reason: null, followUps: 0,
  }],
});

function discovery(overrides: Record<string, unknown>) {
  return { discovery: {
    brief, latestRun: null, proposals: [], decided: [], clarification: null, latestJob: null,
    modelAvailable: true, placeProviderAvailable: true, ...overrides,
  } };
}

it("walks 調查 step by step: questions first, required answers, then research handed to the trip shell", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const queued = job({ status: "queued", stage: null, stages: stages([], null) });
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ path, method, body: JSON.parse(String(init?.body)) });
    let value: unknown;
    if (path.endsWith("/discovery") && method === "GET") value = discovery({});
    else if (path.endsWith("/trip-places")) value = { tripPlaces: [] };
    else if (path.endsWith("/discovery/clarification") && method === "POST") value = discovery({ clarification: checklist("asking", null, 1) });
    else if (path.endsWith("/discovery/clarification/answers") && method === "PUT") value = discovery({ clarification: checklist("ready", "想", 2) });
    else if (path.endsWith("/discovery/research") && method === "POST") value = discovery({ clarification: checklist("ready", "想", 2), latestJob: queued });
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };
  const onJobStarted = vi.fn();
  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={onJobStarted} />);

  fireEvent.click(await screen.findByRole("button", { name: "下一步：讓 AI 先問幾題" }));
  // The required question blocks research until it is answered.
  const blocked = await screen.findByRole("button", { name: "還有 1 題必填" });
  expect(blocked).toBeDisabled();
  expect(calls.map((call) => call.path.split("/discovery")[1])).toEqual(["/clarification"]);

  fireEvent.click(screen.getByRole("radio", { name: "想" }));
  fireEvent.click(await screen.findByRole("button", { name: "開始找地點" }));

  await waitFor(() => expect(onJobStarted).toHaveBeenCalledWith(expect.objectContaining({ id: queued.id, status: "queued" })));
  expect(calls.map((call) => [call.method, call.path.split("/discovery")[1]])).toEqual([
    ["POST", "/clarification"],
    ["PUT", "/clarification/answers"],
    ["POST", "/research"],
  ]);
  expect(calls[1]!.body).toEqual({ expectedVersion: 1, answers: [{ id: "q1", answer: "想" }] });
  expect(calls[2]!.body).toEqual({ expectedBriefVersion: 1 });
});

it("shows a running job's current stage at the top, then the places that run found, marked new", async () => {
  const runId = "77777777-7777-4777-8777-777777777777";
  const fresh = { ...proposal, id: "88888888-8888-4888-8888-888888888888", runId, name: "東福寺", providerPlaceId: "ChIJ-Tofukuji" };
  const saved = job({ status: "running", stage: "photos", stages: stages(["plan", "discover", "research", "verify", "save"], "photos"), addedCount: 1 });
  let workspace = discovery({ proposals: [proposal] });
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) value = workspace;
    else if (path.endsWith("/trip-places")) value = { tripPlaces: [] };
    else if (path.includes("/place-previews?")) value = { previews: [] };
    else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };
  const running = job({ stage: "discover", stages: stages(["plan"], "discover") });
  const view = render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={running as never} onJobStarted={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "AI 正在找地點" })).toBeInTheDocument();
  expect(screen.getByText(/在地圖上找店中/)).toBeInTheDocument();
  expect(screen.getByText("找到的地點會出現在這裡。")).toBeInTheDocument();

  // The save stage finished: the page re-reads the list and the new place appears in the batch.
  workspace = discovery({
    proposals: [fresh, proposal],
    latestRun: { id: runId, status: "completed", modelId: "m", policyVersion: "p", briefVersion: 1, searchPlan: { queries: [], areas: [], categories: [], defaultCategories: false, namedPlaces: [], alreadyArranged: [], exclusions: [], dateRange: { start: trip.startDate, end: trip.endDate } }, generatedAt: "2026-10-19T10:00:06.000Z", errorCode: null, shortfalls: [] },
    latestJob: saved,
  });
  view.rerender(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={saved as never} onJobStarted={vi.fn()} />);

  const batch = (await screen.findByRole("heading", { name: "AI 找到 1 個地點" })).closest("section")!;
  await waitFor(() => expect(batch.querySelector('[data-discovery-proposal="東福寺"]')).not.toBeNull());
  expect(batch.querySelector('[data-discovery-proposal="東福寺"]')).toHaveTextContent("新");
  // Older places stay in the list below, not in the batch.
  expect(batch.querySelector('[data-discovery-proposal="錦市場"]')).toBeNull();
  expect(document.querySelector('[data-discovery-proposal="錦市場"]')).not.toBeNull();
});

/** A phone that answers getCurrentPosition with this fix, or with a permission denial. */
function stubPhonePosition(outcome: { latitude: number; longitude: number } | "denied", secure = true) {
  replaceProperty(window, "isSecureContext", secure);
  const getCurrentPosition = vi.fn((success: PositionCallback, failure?: PositionErrorCallback | null, _options?: PositionOptions) => {
    if (outcome === "denied") failure?.({ code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    else success({ coords: { ...outcome, accuracy: 25 }, timestamp: Date.now() } as unknown as GeolocationPosition);
  });
  replaceProperty(navigator, "geolocation", { getCurrentPosition });
  return getCurrentPosition;
}

/** 調查 with no questions: one click asks for the checklist, then queues research at once. */
async function investigateWithCenter(searchCenter: unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const queued = job({ status: "queued", stage: null, stages: stages([], null) });
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ path: path.split("/discovery")[1]!, body: JSON.parse(String(init?.body)) });
    let value: unknown;
    if (path.endsWith("/discovery") && method === "GET") value = discovery({});
    else if (path.endsWith("/trip-places")) value = { tripPlaces: [] };
    else if (path.endsWith("/discovery/clarification") && method === "POST") value = discovery({ clarification: checklist("ready", "想", 1), searchCenter });
    else if (path.endsWith("/discovery/research") && method === "POST") value = discovery({ clarification: checklist("ready", "想", 1), latestJob: queued, searchCenter });
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };
  const onJobStarted = vi.fn();
  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} job={null} onJobStarted={onJobStarted} />);
  fireEvent.click(await screen.findByRole("button", { name: "下一步：讓 AI 先問幾題" }));
  await waitFor(() => expect(onJobStarted).toHaveBeenCalledWith(expect.objectContaining({ id: queued.id })));
  return calls;
}

it("sends the phone position rounded to 3 decimals with both 調查 starts and says it searched near you", async () => {
  const getCurrentPosition = stubPhonePosition({ latitude: 35.003456, longitude: 135.768912 });

  const calls = await investigateWithCenter({ source: "device", label: null });

  const near = { latitude: 35.003, longitude: 135.769 };
  expect(calls).toEqual([
    { path: "/clarification", body: { expectedBriefVersion: 1, near } },
    { path: "/research", body: { expectedBriefVersion: 1, near } },
  ]);
  expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  expect(getCurrentPosition.mock.calls[0]![2]).toEqual({ enableHighAccuracy: false, timeout: 8_000, maximumAge: 600_000 });
  expect((await screen.findAllByText("以你目前位置附近搜尋")).length).toBeGreaterThan(0);
});

it("sends no position when the traveler denies it, and names tonight's lodging the server used", async () => {
  stubPhonePosition("denied");

  const calls = await investigateWithCenter({ source: "lodging", label: "京都車站飯店" });

  expect(calls.map((call) => call.body)).toEqual([{ expectedBriefVersion: 1 }, { expectedBriefVersion: 1 }]);
  expect((await screen.findAllByText("以今晚住宿「京都車站飯店」附近搜尋")).length).toBeGreaterThan(0);
  expect(screen.queryByText("以你目前位置附近搜尋")).toBeNull();
});

it("never asks for the position outside a secure page and shows no center line when the server had none", async () => {
  const getCurrentPosition = stubPhonePosition({ latitude: 35, longitude: 135.7 }, false);

  const calls = await investigateWithCenter(null);

  expect(getCurrentPosition).not.toHaveBeenCalled();
  expect(calls.map((call) => call.body)).toEqual([{ expectedBriefVersion: 1 }, { expectedBriefVersion: 1 }]);
  expect(screen.queryByText(/附近搜尋/)).toBeNull();
});
