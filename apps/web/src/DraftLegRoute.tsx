import { useId, useState } from "react";
import type { DayTimeline } from "@along-the-way/contracts/day-timeline";
import type { PlanningRouteNodeDto } from "@along-the-way/contracts/planning";
import { MapPin } from "lucide-react";

import { googleMapsDirectionsUrl } from "./google-maps";

export interface DraftLegPoint {
  latitude: number;
  longitude: number;
}

/** The Maps Embed API's limit on stops between origin and destination. */
const EMBED_MAX_WAYPOINTS = 20;

/**
 * A Maps Embed directions URL (free and unmetered). Every point is coordinates, never a name, so
 * Google never guesses a place. transit takes no waypoints; only driving draws a route through them.
 * https://developers.google.com/maps/documentation/embed/embedding-map#directions_mode
 */
function embedDirectionsUrl(browserKey: string, mode: "transit" | "driving", from: DraftLegPoint, to: DraftLegPoint, waypoints: readonly DraftLegPoint[] = []) {
  const url = new URL("https://www.google.com/maps/embed/v1/directions");
  url.searchParams.set("key", browserKey);
  url.searchParams.set("origin", `${from.latitude},${from.longitude}`);
  url.searchParams.set("destination", `${to.latitude},${to.longitude}`);
  if (waypoints.length > 0) url.searchParams.set("waypoints", waypoints.map((point) => `${point.latitude},${point.longitude}`).join("|"));
  url.searchParams.set("mode", mode);
  url.searchParams.set("language", "zh-TW");
  return url.toString();
}

/**
 * The day's endpoint ids in the order the draft's timeline walks them: each leg's from → to, and each
 * stop (a first stop after an unknown start has no leg). A fixed item appears only by the end the day
 * touches, so a flight's far airport never shows. Without a timeline (no window, an older draft) the
 * load's `route` stands in with lodging and stops only: it cannot tell which end of a fixed item is on the day.
 */
function dayPointIds(route: readonly PlanningRouteNodeDto[], timeline: DayTimeline | null | undefined) {
  const ids: string[] = [];
  const add = (id: string) => {
    if (ids.at(-1) !== id) ids.push(id);
  };
  if (timeline?.kind === "rows") {
    for (const row of timeline.rows) {
      if (row.kind === "leg" || row.kind === "tail_unknown") {
        add(row.fromId);
        add(row.toId);
      } else if (row.kind === "stop") add(row.stopId);
    }
    return ids;
  }
  for (const node of route) if (node.kind !== "anchor") add(node.start.id);
  return ids;
}

/**
 * The whole day in the draft's order on one driving map: only for seeing the order and detours, since
 * transit cannot pass through stops. Points without coordinates are left off and counted; nothing
 * without a stop, a key or two located points.
 */
export function DraftDayRoute({ route, timeline, points, title, browserKey }: {
  route: readonly PlanningRouteNodeDto[];
  timeline: DayTimeline | null | undefined;
  /** Located endpoints by id, from the same `route`. */
  points: ReadonlyMap<string, DraftLegPoint>;
  title: string;
  browserKey: string | null;
}) {
  if (!browserKey || !route.some((node) => node.kind === "flexible" || node.kind === "pinned")) return null;
  const located: DraftLegPoint[] = [];
  const missing = new Set<string>();
  for (const id of dayPointIds(route, timeline)) {
    const point = points.get(id);
    if (point) located.push(point);
    else missing.add(id);
  }
  if (located.length < 2) return null;
  const between = located.slice(1, -1);
  const waypoints = between.slice(0, EMBED_MAX_WAYPOINTS);
  return (
    <div className="whole-trip-day-map">
      <p>整天的順序和位置（Google 開車路線，只用來看順序和繞路；搭車要多久請看下面每一段的『看路線』）。</p>
      <iframe
        title={title}
        src={embedDirectionsUrl(browserKey, "driving", located[0]!, located.at(-1)!, waypoints)}
        width="100%"
        height={360}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
      {missing.size > 0 ? <p>有 {missing.size} 個地點沒有座標，沒畫在圖上。</p> : null}
      {between.length > EMBED_MAX_WAYPOINTS
        ? <p>Google 一張圖最多畫 {EMBED_MAX_WAYPOINTS} 個中途點，後面 {between.length - EMBED_MAX_WAYPOINTS} 個沒畫，直接連到終點。</p>
        : null}
    </div>
  );
}

/** 「看路線」 (needs a browser key) and the Google Maps link for one leg; nothing when an end is invalid. */
export function DraftLegRoute({ from, to, fromName, toName, browserKey }: {
  from: DraftLegPoint;
  to: DraftLegPoint;
  fromName: string;
  toName: string;
  browserKey: string | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const directions = googleMapsDirectionsUrl({ ...from, providerPlaceId: null }, { ...to, providerPlaceId: null }, "transit");
  if (!directions) return null;
  return (
    <div className="whole-trip-leg-route">
      <div className="whole-trip-leg-route__actions">
        {browserKey ? (
          <button
            type="button"
            className="whole-trip-inline-action"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "收起路線" : "看路線"}
          </button>
        ) : null}
        <a
          className="whole-trip-leg-route__link"
          href={directions}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在 Google Maps 查看「${fromName}」到「${toName}」的大眾運輸路線（另開新分頁）`}
        >
          <MapPin aria-hidden="true" /> Google Maps
        </a>
      </div>
      {browserKey && open ? (
        <div className="whole-trip-leg-route__panel" id={panelId}>
          <p>Google 建議的搭法，時間以 Google 為準；系統排序用的是上面的估計分鐘。</p>
          <iframe
            title={`「${fromName}」到「${toName}」的 Google 大眾運輸路線`}
            src={embedDirectionsUrl(browserKey, "transit", from, to)}
            width="100%"
            height={320}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      ) : null}
    </div>
  );
}
