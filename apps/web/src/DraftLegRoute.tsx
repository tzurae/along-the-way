import { useId, useState } from "react";
import { MapPin } from "lucide-react";

import { googleMapsDirectionsUrl } from "./google-maps";

export interface DraftLegPoint {
  latitude: number;
  longitude: number;
}

/**
 * Google's own transit route for one draft leg, so the owner can check the planner's straight-line
 * estimate against it. The Maps Embed API is free and unmetered; transit takes no waypoints, so each
 * leg is its own iframe, loaded only when opened. Both ends are coordinates, never names.
 * https://developers.google.com/maps/documentation/embed/embedding-map#directions_mode
 */
function embedDirectionsUrl(browserKey: string, from: DraftLegPoint, to: DraftLegPoint) {
  const url = new URL("https://www.google.com/maps/embed/v1/directions");
  url.searchParams.set("key", browserKey);
  url.searchParams.set("origin", `${from.latitude},${from.longitude}`);
  url.searchParams.set("destination", `${to.latitude},${to.longitude}`);
  url.searchParams.set("mode", "transit");
  url.searchParams.set("language", "zh-TW");
  return url.toString();
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
            src={embedDirectionsUrl(browserKey, from, to)}
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
