/// <reference types="google.maps" />

import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  parseDayRouteResponse,
  parseDayRouteShapesResponse,
  withTransitMatrix,
  type CreateDayRouteInput,
  type DayRouteDto,
  type DayRouteOrder,
  type DayRouteResponse,
  type DayRouteShapesResponse,
} from "@along-the-way/contracts/day-plans";
import {
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type TripPlaceDto,
  type TripPlaceListResponse,
  type TripPlaceResponse,
} from "@along-the-way/contracts/trip-places";
import { parseMapsConfigResponse, type MapsConfigResponse } from "@along-the-way/contracts/maps";
import { AdvancedMarker, APIProvider, Map as GoogleMap, Pin, useMap } from "@vis.gl/react-google-maps";
import { Check, Clock3, GripVertical, MapPin, RotateCcw, Route, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n, type Messages } from "./i18n";
import { ApiRequestError } from "./api-error";
import { notify } from "./AppToaster";
import { busLikelyShapeLegs, isBusLikelyMinutesLeg, routeLegKey } from "./bus-likely-leg";
import { googleMapsDirectionsUrl } from "./google-maps";
import { PlaceListSkeleton } from "./PlaceListSkeleton";
import { dayReturnLine, durationText, estimateDayReturn, stayText } from "./day-return-time";
import { useDayOverrideOpener } from "./WholeTripPlanning";

type JsonRequest = <T>(
  url: string,
  options?: RequestInit & { parse?: (value: unknown) => unknown },
) => Promise<T>;

declare global {
  interface Window {
    gm_authFailure?: () => void;
  }
}

const googleAuthFailureListeners = new Set<() => void>();
let previousGoogleAuthFailure: (() => void) | undefined;
let googleAuthFailureDispatcher: (() => void) | undefined;

function subscribeGoogleAuthFailure(listener: () => void) {
  if (!googleAuthFailureDispatcher) {
    previousGoogleAuthFailure = window.gm_authFailure;
    googleAuthFailureDispatcher = () => {
      for (const activeListener of googleAuthFailureListeners) activeListener();
      previousGoogleAuthFailure?.();
    };
    window.gm_authFailure = googleAuthFailureDispatcher;
  }
  googleAuthFailureListeners.add(listener);
  return () => {
    googleAuthFailureListeners.delete(listener);
    if (googleAuthFailureListeners.size !== 0) return;
    if (window.gm_authFailure === googleAuthFailureDispatcher) {
      if (previousGoogleAuthFailure) window.gm_authFailure = previousGoogleAuthFailure;
      else delete window.gm_authFailure;
    }
    previousGoogleAuthFailure = undefined;
    googleAuthFailureDispatcher = undefined;
  };
}

export interface PlannedDay {
  id: string;
  date: string;
  label: string;
}

const kilometres = (meters: number) => `${(meters / 1_000).toFixed(1)} 公里`;

/** A leg that should have a distance (both ends exist) but has none because a point lacks coordinates. */
function missesLeg(route: DayRouteDto) {
  return route.stops.some((stop, index) => stop.metersFromPrevious === null && (index > 0 || route.startsAt !== null))
    || (route.stops.length > 0 && route.endsAt !== null && route.metersToEnd === null);
}

/**
 * How the candidate's straight-line total compares with its baseline: the saved order, or, once
 * places were taken off the day, the saved order without them, so dropping a far place is never
 * shown as a better ordering. Under 100 m apart counts as the same length, so rounding noise is
 * never presented as an improvement.
 */
function candidateDelta(baseline: DayRouteDto, candidate: DayRouteDto, sameText: string) {
  if (candidate.travelSource !== "straight_line") {
    if (baseline.totalMinutes === null || candidate.totalMinutes === null) {
      return { tone: "same", text: "部分路段為估計，無法比較總時間" } as const;
    }
    const minutes = candidate.totalMinutes - baseline.totalMinutes;
    return minutes === 0 ? { tone: "same", text: "移動時間相同" } as const
      : minutes < 0 ? { tone: "shorter", text: `↓ 少 ${-minutes} 分鐘` } as const
        : { tone: "longer", text: `↑ 多 ${minutes} 分鐘` } as const;
  }
  const difference = candidate.totalMeters - baseline.totalMeters;
  if (Math.abs(difference) < 100) return { tone: "same", text: sameText } as const;
  return difference < 0
    ? { tone: "shorter", text: `↓ 少 ${kilometres(-difference)}` } as const
    : { tone: "longer", text: `↑ 多 ${kilometres(difference)}` } as const;
}

type ShapeState = { status: "loading" | "ready" | "error"; legs: DayRouteShapesResponse["legs"]; travelNotice?: DayRouteShapesResponse["travelNotice"] };

/** Google has no server cache: keep the paid matrix only in this dialog, checking every coordinate. */
function withDialogTransit(route: DayRouteDto, source: DayRouteDto | null): DayRouteDto {
  if (source?.travelSource !== "google_routes" || route.transitProvider !== "google_routes" || source.date !== route.date) return route;
  return withTransitMatrix(route, source.transitMatrix, "google_routes");
}

/** A cache-only refresh cannot replace a still-valid paid Google restore target. */
function retainGoogleSuggestion(previous: DayRouteDto | undefined, fresh: DayRouteDto): DayRouteDto {
  if (previous?.travelSource !== "google_routes" || fresh.transitProvider !== "google_routes"
    || previous.dayId !== fresh.dayId || previous.date !== fresh.date
    || previous.stops.length !== fresh.stops.length) return fresh;
  const points = new Map(fresh.stops.map((stop) => [stop.tripPlaceId, stop]));
  for (const stop of previous.stops) {
    const point = points.get(stop.tripPlaceId);
    if (!point || point.latitude !== stop.latitude || point.longitude !== stop.longitude) return fresh;
  }
  for (const side of ["startsAt", "endsAt"] as const) {
    const before = previous[side];
    const after = fresh[side];
    if (before?.placeId !== after?.placeId || before?.latitude !== after?.latitude
      || before?.longitude !== after?.longitude) return fresh;
  }
  return { ...previous, version: fresh.version, transitCallsNeeded: fresh.transitCallsNeeded };
}

/** Coordinates are part of the snapshot identity; responses live only in this open dialog. */
function routeShapeKey(route: DayRouteDto) {
  return JSON.stringify([
    route.dayId, route.date,
    route.startsAt && [route.startsAt.placeId, route.startsAt.latitude, route.startsAt.longitude],
    route.stops.map((stop) => [stop.tripPlaceId, stop.latitude, stop.longitude]),
    route.endsAt && [route.endsAt.placeId, route.endsAt.latitude, route.endsAt.longitude],
  ]);
}

type RouteView = "route" | "map";
const routeViews: readonly RouteView[] = ["route", "map"];

function moveRouteViewTab(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  current: RouteView,
  select: (next: RouteView) => void,
  tabPrefix: string,
) {
  const currentIndex = routeViews.indexOf(current);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % routeViews.length;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + routeViews.length) % routeViews.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = routeViews.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const next = routeViews[nextIndex]!;
  select(next);
  document.getElementById(`${tabPrefix}-${next}-tab`)?.focus();
}

interface RouteMapPoint {
  key: string;
  label: string;
  name: string;
  position: google.maps.LatLngLiteral;
}

function routeMapPoints(route: DayRouteDto): RouteMapPoint[] {
  const points: RouteMapPoint[] = [];
  if (route.startsAt && route.startsAt.latitude !== null && route.startsAt.longitude !== null) {
    points.push({
      key: `start-${route.startsAt.placeId}`,
      label: "起",
      name: route.startsAt.name,
      position: { lat: route.startsAt.latitude, lng: route.startsAt.longitude },
    });
  }
  route.stops.forEach((stop, index) => {
    if (stop.latitude === null || stop.longitude === null) return;
    points.push({
      key: stop.tripPlaceId,
      label: String(index + 1),
      name: stop.name,
      position: { lat: stop.latitude, lng: stop.longitude },
    });
  });
  if (route.endsAt && route.endsAt.latitude !== null && route.endsAt.longitude !== null) {
    points.push({
      key: `end-${route.endsAt.placeId}`,
      label: "終",
      name: route.endsAt.name,
      position: { lat: route.endsAt.latitude, lng: route.endsAt.longitude },
    });
  }
  return points;
}

const TRANSIT_ROUTE_COLOR = "#1f3029";
const WALK_ROUTE_COLOR = "#52645c";
const BUS_LIKELY_ROUTE_COLOR = "#b55737";

interface RouteLegendLine {
  color: string;
  label: string;
}

function routeLegendLines(
  route: DayRouteDto,
  shapes: DayRouteShapesResponse["legs"],
  fallbackLabel: string,
): RouteLegendLine[] {
  const linesByLeg = new Map<string, string[]>();
  route.stops.forEach((stop, index) => {
    const fromId = index > 0 ? route.stops[index - 1]!.tripPlaceId : route.startsAt?.placeId;
    if (fromId) linesByLeg.set(`${fromId}:${stop.tripPlaceId}`, stop.linesFromPrevious);
  });
  const lastStop = route.stops.at(-1);
  if (lastStop && route.endsAt) {
    linesByLeg.set(`${lastStop.tripPlaceId}:${route.endsAt.placeId}`, route.linesToEnd);
  }

  const distinct = new Map<string, RouteLegendLine>();
  for (const leg of shapes) {
    const features = leg.geojson?.features.filter((feature) => feature.properties.ways === "transport") ?? [];
    const names = linesByLeg.get(`${leg.fromId}:${leg.toId}`) ?? [];
    const namesMatch = names.length === features.length;
    features.forEach((feature, index) => {
      const color = feature.properties.inline.color ?? TRANSIT_ROUTE_COLOR;
      const matchedName = namesMatch ? names[index]?.trim() : "";
      const label = matchedName || fallbackLabel;
      distinct.set(`${color}:${label}`, { color, label });
    });
  }
  return [...distinct.values()];
}


function RouteMapOverlay({
  points,
  shapes,
  busLikelyKeys,
  visibilityRevision,
}: {
  points: RouteMapPoint[];
  shapes: DayRouteShapesResponse["legs"];
  busLikelyKeys: ReadonlySet<string>;
  visibilityRevision: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend(point.position));
    for (const leg of shapes) {
      for (const feature of leg.geojson?.features ?? []) {
        const paths = feature.geometry.type === "LineString"
          ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        for (const path of paths) for (const [lng, lat] of path) bounds.extend({ lat, lng });
      }
    }
    map.fitBounds(bounds, 48);
  }, [map, points, shapes, visibilityRevision]);

  useEffect(() => {
    if (!map) return;
    const lines: google.maps.Polyline[] = [];
    for (const leg of shapes) {
      const busLikely = busLikelyKeys.has(routeLegKey(leg.fromId, leg.toId));
      for (const feature of leg.geojson?.features ?? []) {
        const walk = feature.properties.ways === "walk";
        const paths = feature.geometry.type === "LineString"
          ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        for (const path of paths) {
          lines.push(new google.maps.Polyline({
            map,
            path: path.map(([lng, lat]) => ({ lat, lng })),
            geodesic: false,
            strokeColor: busLikely
              ? BUS_LIKELY_ROUTE_COLOR
              : walk ? WALK_ROUTE_COLOR : feature.properties.inline.color ?? TRANSIT_ROUTE_COLOR,
            strokeOpacity: walk ? 0 : 1,
            strokeWeight: busLikely ? 6 : 5,
            zIndex: busLikely ? 2 : 1,
            ...(walk ? { icons: [{
              icon: {
                path: "M 0,-1 0,1",
                strokeColor: busLikely ? BUS_LIKELY_ROUTE_COLOR : WALK_ROUTE_COLOR,
                strokeOpacity: 1,
                strokeWeight: busLikely ? 6 : 3,
                scale: 2,
              },
              offset: "0",
              repeat: busLikely ? "16px" : "12px",
            }] } : {}),
          }));
        }
      }
    }
    return () => lines.forEach((line) => line.setMap(null));
  }, [busLikelyKeys, map, shapes]);

  return null;
}

function RouteMapView({
  route,
  date,
  points,
  shapes,
  mapId,
  visibilityRevision,
}: {
  route: DayRouteDto;
  date: string;
  points: RouteMapPoint[];
  shapes: DayRouteShapesResponse["legs"];
  mapId: string | null;
  visibilityRevision: boolean;
}) {
  const { t } = useI18n();
  const likelyBusLegs = useMemo(() => busLikelyShapeLegs(route, shapes), [route, shapes]);
  const busLikelyKeys = useMemo(() => new Set(likelyBusLegs.map((leg) => leg.key)), [likelyBusLegs]);
  return (
    <div className="route-map-shell" aria-label={`${date} 的路線地圖`}>
      <GoogleMap
        className="route-map"
        defaultCenter={points[0]!.position}
        defaultZoom={12}
        gestureHandling="cooperative"
        mapId={mapId ?? "DEMO_MAP_ID"}
      >
        <RouteMapOverlay
          points={points}
          shapes={shapes}
          busLikelyKeys={busLikelyKeys}
          visibilityRevision={visibilityRevision}
        />
        {likelyBusLegs.map((leg) => (
          <AdvancedMarker key={`bus-likely-${leg.key}`} position={leg.midpoint} title={t.dayPlan.busLikely}>
            <span className="route-map-bus-likely-label">{t.dayPlan.busLikely}</span>
          </AdvancedMarker>
        ))}
        {points.map((point) => (
          <AdvancedMarker key={point.key} position={point.position} title={`${point.label}・${point.name}`}>
            <Pin
              background="#d37551"
              borderColor="#1f3029"
              glyphColor="#ffffff"
              glyphText={point.label}
            />
          </AdvancedMarker>
        ))}
      </GoogleMap>
    </div>
  );
}

type RouteMapLoadState = "reserving" | "ready" | "quota-error" | "reservation-error" | "script-error" | "auth-error";

function RouteMapError({
  message,
  retry,
  retryLabel = "重試",
  onShowRoute,
}: {
  message: string;
  retry?: () => void;
  retryLabel?: string;
  onShowRoute(): void;
}) {
  return (
    <div role="alert" className="route-map-status route-status route-map-error">
      <p>{message}</p>
      <div className="route-map-error-actions">
        {retry ? <button type="button" className="route-link-button" onClick={retry}>{retryLabel}</button> : null}
        <button type="button" className="route-link-button" onClick={onShowRoute}>改看路線</button>
      </div>
    </div>
  );
}

function ReservedRouteMap({
  route,
  shapes,
  browserKey,
  mapId,
  request,
  visibilityRevision,
  onRetry,
  onShowRoute,
}: {
  route: DayRouteDto;
  shapes: DayRouteShapesResponse["legs"];
  browserKey: string;
  mapId: string | null;
  request: JsonRequest;
  visibilityRevision: boolean;
  onRetry(): void;
  onShowRoute(): void;
}) {
  const points = useMemo(() => routeMapPoints(route), [route]);
  const reservation = useRef<Promise<void> | null>(null);
  const [state, setState] = useState<RouteMapLoadState>("reserving");

  useEffect(() => subscribeGoogleAuthFailure(() => {
    setState("auth-error");
  }), []);

  useEffect(() => {
    let active = true;
    const pending = reservation.current
      ?? request<void>("/api/maps/load", { method: "POST" });
    reservation.current = pending;
    void pending.then(
      () => {
        if (active) setState((current) => current === "auth-error" ? current : "ready");
      },
      (reason: unknown) => {
        if (!active) return;
        setState((current) => {
          if (current === "auth-error") return current;
          return reason instanceof ApiRequestError
            && reason.status === 429
            && reason.code === "maps_daily_limit"
            ? "quota-error"
            : "reservation-error";
        });
      },
    );
    return () => {
      active = false;
    };
  }, [request]);

  if (state === "reserving") {
    return <p role="status" className="route-map-status">正在載入地圖…</p>;
  }
  if (state === "quota-error") {
    return (
      <RouteMapError
        message="今天的地圖額度已用完，明天會恢復；「路線」分頁不受影響。"
        onShowRoute={onShowRoute}
      />
    );
  }
  if (state === "reservation-error") {
    return <RouteMapError message="無法載入地圖，請稍後再試。" retry={onRetry} onShowRoute={onShowRoute} />;
  }
  if (state === "auth-error") {
    return <RouteMapError message="Google 地圖設定有問題，暫時無法顯示地圖。" onShowRoute={onShowRoute} />;
  }
  if (state === "script-error") {
    // The Google loader keeps its failed status for the life of the page, so remounting
    // APIProvider cannot recover; only a page reload starts a fresh script load.
    return (
      <RouteMapError
        message="地圖載入失敗，請檢查網路後重新整理頁面。"
        retry={() => window.location.reload()}
        retryLabel="重新整理頁面"
        onShowRoute={onShowRoute}
      />
    );
  }
  return (
    <APIProvider apiKey={browserKey} onError={() => setState("script-error")}>
      <RouteMapView route={route} date={route.date} points={points} shapes={shapes} mapId={mapId} visibilityRevision={visibilityRevision} />
    </APIProvider>
  );
}

function RouteMapPanel({
  route,
  shapes,
  config,
  loading,
  error,
  request,
  visibilityRevision,
  onShowRoute,
}: {
  route: DayRouteDto;
  shapes: DayRouteShapesResponse["legs"];
  config: MapsConfigResponse | null;
  loading: boolean;
  error: string;
  request: JsonRequest;
  visibilityRevision: boolean;
  onShowRoute(): void;
}) {
  const points = useMemo(() => routeMapPoints(route), [route]);
  const [attempt, setAttempt] = useState(0);
  if (loading) {
    return <p role="status" className="route-map-status">正在載入 Google 地圖設定…</p>;
  }
  if (error) {
    return <RouteMapError message={error} onShowRoute={onShowRoute} />;
  }
  if (!config?.browserKey) {
    return <RouteMapError message="尚未設定 Google 地圖金鑰" onShowRoute={onShowRoute} />;
  }
  if (points.length === 0) {
    return <RouteMapError message="沒有可顯示的座標" onShowRoute={onShowRoute} />;
  }
  return (
    <ReservedRouteMap
      key={attempt}
      route={route}
      shapes={shapes}
      browserKey={config.browserKey}
      mapId={config.mapId}
      request={request}
      visibilityRevision={visibilityRevision}
      onRetry={() => setAttempt((current) => current + 1)}
      onShowRoute={onShowRoute}
    />
  );
}

type LegEnd = { name: string; latitude: number | null; longitude: number | null; providerPlaceId: string | null };
type LegRowCopy = Pick<Messages["dayPlan"], "busLikely" | "busLikelyWalkDistance" | "googleMapsTransit">;

/** Saved rows retain distance-only copy; candidate rows can show transit or an estimate. */
function legRow(
  key: string,
  meters: number | null,
  from: LegEnd,
  to: LegEnd,
  minutes: number | null,
  lines: string[],
  shapeFailed: boolean,
  version: "saved" | "candidate",
  provider: DayRouteDto["transitProvider"],
  copy: LegRowCopy,
  /** Classification from a loaded shape for this leg; null when no shape evidence exists. */
  shapeBusLikely: boolean | null = null,
) {
  const busLikely = version === "candidate"
    && (shapeBusLikely ?? isBusLikelyMinutesLeg(provider, from, to, minutes, lines));
  const distance = meters === null ? "缺少座標" : meters < 1_000 ? `${meters} 公尺` : `${(meters / 1_000).toFixed(1)} 公里`;
  const directions = googleMapsDirectionsUrl(from, to, busLikely ? "transit" : undefined);
  const travel = busLikely
    ? copy.busLikelyWalkDistance(((meters ?? 0) / 1_000).toFixed(1))
    : version === "saved" ? distance
      : minutes === null ? `估計・${distance}`
        : lines.length > 0 ? `${minutes} 分鐘・${lines.join(" → ")}` : `步行 ${minutes} 分鐘`;
  return (
    <li key={key} className={`route-leg${busLikely ? " route-leg--bus-likely" : ""}`}>
      <span aria-hidden="true" />
      <span className="route-leg-track" aria-hidden="true" />
      <span className="route-leg-text">
        <span className={busLikely ? "route-leg-warning" : undefined}><span aria-hidden="true">↓ </span>{travel}</span>
        {shapeFailed ? <span>這段路線無法取得</span> : null}
        {directions ? (
          <a
            className={`route-leg-directions${busLikely ? " route-leg-directions--transit" : ""}`}
            href={directions}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={busLikely
              ? `${copy.googleMapsTransit}：「${from.name}」到「${to.name}」（另開新分頁）`
              : `在 Google Maps 查看「${from.name}」到「${to.name}」的交通方式（另開新分頁）`}
          >
            <MapPin aria-hidden="true" /> {busLikely ? copy.googleMapsTransit : "Google Maps"}
          </a>
        ) : null}
      </span>
    </li>
  );
}

export function DayPlanDialog({
  tripId,
  day,
  canArrange,
  request,
  onClose,
  onOrderSaved,
  places,
  onPlaceUpdated,
}: {
  tripId: string;
  day: PlannedDay | null;
  /** Owner, or an editor the owner allows to arrange the itinerary. */
  canArrange: boolean;
  request: JsonRequest;
  onClose(): void;
  onOrderSaved(): Promise<void>;
  /** The trip's places: a stay edit writes the same planning facts the place sheet edits, at this version. */
  places: readonly TripPlaceDto[];
  /** A place's planning facts were saved; refresh the places this dialog was given. */
  onPlaceUpdated(): Promise<void>;
}) {
  const { t } = useI18n();
  const routeViewId = useId();
  const savedTabPrefix = `${routeViewId}-saved`;
  const candidateTabPrefix = `${routeViewId}-candidate`;
  const [routes, setRoutes] = useState<Partial<Record<DayRouteOrder, DayRouteDto>>>({});
  const [view, setView] = useState<"candidate" | "saved">("candidate");
  const [savedTab, setSavedTab] = useState<RouteView>("route");
  const [candidateTab, setCandidateTab] = useState<RouteView>("route");
  const [mapsConfig, setMapsConfig] = useState<MapsConfigResponse | null>(null);
  const [mapsConfigLoading, setMapsConfigLoading] = useState(false);
  const [mapsConfigError, setMapsConfigError] = useState("");
  const [busy, setBusy] = useState<"planning" | "transit" | "saving" | "stay" | null>(null);
  const [transitCallsNotice, setTransitCallsNotice] = useState("");
  const [stayEdit, setStayEdit] = useState<{ tripPlaceId: string; value: string; error: string } | null>(null);
  const openDayOverride = useDayOverrideOpener(day?.id ?? null);
  const latestRequest = useRef(0);
  const mapsConfigRequest = useRef(0);
  const dialogEpoch = useRef(0);
  const actionKeys = useRef(new Map<string, string>());
  const initialRouteRequest = useRef<{ dayId: string; pending: Promise<[DayRouteDto, DayRouteDto]> } | null>(null);
  const shapeRequests = useRef(new Set<string>());
  const [shapeStates, setShapeStates] = useState<Record<string, ShapeState>>({});

  const saved = routes.current ?? null;
  const candidate = routes.custom ?? routes.suggested ?? null;
  const transitSource = candidate && candidate.travelSource !== "straight_line" ? candidate : null;
  const transitCallsNeeded = routes.suggested?.transitCallsNeeded ?? candidate?.transitCallsNeeded ?? 0;
  const suggestedLabel = routes.suggested && routes.suggested.travelSource !== "straight_line" ? "依交通時間排" : "依直線距離排";
  const providerName = candidate?.transitProvider === "google_routes" ? "Google" : "NAVITIME";

  function selectRouteTab(version: "saved" | "candidate", next: RouteView) {
    if (version === "saved") setSavedTab(next);
    else setCandidateTab(next);
    if (version === "saved") return;
    const route = candidate;
    if (next !== "map" || !route?.routeShapesAvailable) return;
    const key = routeShapeKey(route);
    if (shapeRequests.current.has(key)) return;
    shapeRequests.current.add(key);
    const epoch = dialogEpoch.current;
    setShapeStates((current) => ({ ...current, [key]: { status: "loading", legs: [] } }));
    void request<DayRouteShapesResponse>(`/api/trips/${tripId}/days/${route.dayId}/route-shapes`, {
      method: "POST",
      body: JSON.stringify({ orderedTripPlaceIds: route.orderedTripPlaceIds }),
      parse: parseDayRouteShapesResponse,
    }).then((response) => {
      if (epoch !== dialogEpoch.current) return;
      setShapeStates((current) => ({ ...current, [key]: { status: "ready", legs: response.legs, travelNotice: response.travelNotice } }));
    }, () => {
      if (epoch !== dialogEpoch.current) return;
      setShapeStates((current) => ({ ...current, [key]: { status: "error", legs: [] } }));
    });
  }

  function shapeFailed(route: DayRouteDto, fromId: string, toId: string) {
    const state = shapeStates[routeShapeKey(route)];
    return state?.status === "error"
      || (state?.status === "ready" && !state.legs.some((leg) => leg.fromId === fromId && leg.toId === toId && leg.geojson));
  }

  /** True/false when a loaded candidate shape decides this leg; null when only minute data can. */
  function shapeBusLikely(route: DayRouteDto, fromId: string, toId: string) {
    const state = shapeStates[routeShapeKey(route)];
    if (state?.status !== "ready") return null;
    const leg = state.legs.find((entry) => entry.fromId === fromId && entry.toId === toId);
    if (!leg?.geojson) return null;
    return busLikelyShapeLegs(route, [leg]).length > 0;
  }

  function routeMap(route: DayRouteDto, version: "saved" | "candidate") {
    const state = version === "candidate" ? shapeStates[routeShapeKey(route)] : undefined;
    const legendLines = state?.status === "ready"
      ? routeLegendLines(route, state.legs, t.dayPlan.genericTransit)
      : [];
    const likelyBusLegs = state?.status === "ready" ? busLikelyShapeLegs(route, state.legs) : [];
    const busLikelyKeys = new Set(likelyBusLegs.map((leg) => leg.key));
    const hasWalk = state?.status === "ready"
      && state.legs.some((leg) => !busLikelyKeys.has(routeLegKey(leg.fromId, leg.toId))
        && leg.geojson?.features.some((feature) => feature.properties.ways === "walk"));
    const names = new Map([
      ...route.stops.map((stop) => [stop.tripPlaceId, stop.name] as const),
      ...(route.startsAt ? [[route.startsAt.placeId, route.startsAt.name] as const] : []),
      ...(route.endsAt ? [[route.endsAt.placeId, route.endsAt.name] as const] : []),
    ]);
    return (
      <>
        {version === "saved" || !route.routeShapesAvailable ? (
          <p className="route-version-note">地圖只標出順序；實際怎麼走請點每段的 Google Maps</p>
        ) : null}
        {state?.status === "loading" ? (
          <div className="route-shapes-loading">
            <p>正在取得實際交通與步行路線…</p>
            <PlaceListSkeleton label="正在取得實際交通與步行路線" rows={2} />
          </div>
        ) : null}
        {state?.status === "error" ? <p className="route-version-note" role="status">這段路線無法取得；請到「路線」分頁點每段的 Google Maps。</p> : null}
        {state?.travelNotice ? <p className="route-version-note" role="status">
          {state.travelNotice === "transit_quota"
            ? "Google 的交通查詢額度已用完，未取得的路段不畫線；請點每段 Google Maps 查看走法。"
            : "目前無法取得部分 Google 交通路線；請點每段 Google Maps 查看走法。"}
        </p> : null}
        {state?.legs.filter((leg) => !leg.geojson).map((leg) => (
          <p key={`${leg.fromId}:${leg.toId}`} className="route-version-note">
            {names.get(leg.fromId)} → {names.get(leg.toId)}：這段路線無法取得
          </p>
        ))}
        <RouteMapPanel
          route={route}
          shapes={state?.legs ?? []}
          config={mapsConfig}
          loading={mapsConfigLoading}
          error={mapsConfigError}
          request={request}
          visibilityRevision={view === version}
          onShowRoute={() => selectRouteTab(version, "route")}
        />
        {version === "candidate" && route.routeShapesAvailable ? (
          <div className="route-map-caption">
            {legendLines.length > 0 || hasWalk || likelyBusLegs.length > 0 ? (
              <ul className="route-map-legend" aria-label={t.dayPlan.mapLegendLabel}>
                {legendLines.map((line) => (
                  <li key={`${line.color}:${line.label}`}>
                    <span className="route-map-legend-swatch" style={{ backgroundColor: line.color }} aria-hidden="true" />
                    <span>{line.label}</span>
                  </li>
                ))}
                {hasWalk ? (
                  <li>
                    <span className="route-map-legend-swatch route-map-legend-swatch--walk" aria-hidden="true" />
                    <span>{t.dayPlan.walking}</span>
                  </li>
                ) : null}
                {likelyBusLegs.length > 0 ? (
                  <li>
                    <span className="route-map-legend-swatch route-map-legend-swatch--bus-likely" aria-hidden="true" />
                    <span>{t.dayPlan.busLikelyLegend}</span>
                  </li>
                ) : null}
              </ul>
            ) : null}
            <p className="route-map-attribution">{t.dayPlan.routeProvider(route.transitProvider === "google_routes" ? "Google" : "NAVITIME")}</p>
          </div>
        ) : null}
      </>
    );
  }

  const keyFor = (identity: string) => {
    const existing = actionKeys.current.get(identity);
    if (existing) return existing;
    const created = crypto.randomUUID();
    actionKeys.current.set(identity, created);
    return created;
  };

  const fetchRoute = useCallback(async (dayId: string, input: CreateDayRouteInput) => {
    const response = await request<DayRouteResponse>(`/api/trips/${tripId}/days/${dayId}/route`, {
      method: "POST",
      body: JSON.stringify(input),
      parse: parseDayRouteResponse,
    });
    return response.route;
  }, [request, tripId]);

  // Taking places off the day changes what is compared: the fair baseline is the saved order
  // without those places. The matrix adds travel minutes locally, without another provider call.
  const removedIds = saved && candidate
    ? saved.orderedTripPlaceIds.filter((id) => !candidate.orderedTripPlaceIds.includes(id))
    : [];
  const baselineKey = day && saved && removedIds.length > 0
    ? JSON.stringify({
      epoch: dialogEpoch.current,
      dayId: saved.dayId,
      routeSnapshot: saved,
      orderedTripPlaceIds: saved.orderedTripPlaceIds.filter((id) => !removedIds.includes(id)),
    })
    : null;
  const [baseline, setBaseline] = useState<{ key: string; route: DayRouteDto | null } | null>(null);
  useEffect(() => {
    setBaseline(null);
    if (!baselineKey) return;
    const baselineRequest = JSON.parse(baselineKey) as {
      dayId: string;
      orderedTripPlaceIds: string[];
    };
    let active = true;
    fetchRoute(baselineRequest.dayId, {
      order: "custom",
      orderedTripPlaceIds: baselineRequest.orderedTripPlaceIds,
    }).then(
      (route) => { if (active) setBaseline({ key: baselineKey, route }); },
      () => { if (active) setBaseline({ key: baselineKey, route: null }); },
    );
    return () => { active = false; };
  }, [baselineKey, fetchRoute]);

  const loadRoutes = useCallback(async (dayId: string, epoch: number) => {
    const ticket = ++latestRequest.current;
    setBusy("planning");
    try {
      // Strict Mode can replay the opening effect; share the same cache-only read.
      if (initialRouteRequest.current?.dayId !== dayId) {
        initialRouteRequest.current = {
          dayId,
          pending: Promise.all([
            fetchRoute(dayId, { order: "current" }),
            fetchRoute(dayId, { order: "suggested", transit: "cached" }),
          ]),
        };
      }
      const [current, suggested] = await initialRouteRequest.current.pending;
      if (current.version !== suggested.version) throw new Error("這天的安排已變更，請關閉後重新開啟。");
      if (ticket !== latestRequest.current || epoch !== dialogEpoch.current) return;
      setRoutes({ current, suggested });
      setView("candidate");
    } catch (reason) {
      if (ticket === latestRequest.current && epoch === dialogEpoch.current) {
        notify("error", reason instanceof Error ? reason.message : t.dayPlan.couldNotPlan);
      }
    } finally {
      if (ticket === latestRequest.current && epoch === dialogEpoch.current) setBusy(null);
    }
  }, [fetchRoute, t.dayPlan.couldNotPlan]);

  async function fetchTransitSuggestion() {
    if (!day || busy !== null) return;
    const ticket = ++latestRequest.current;
    const epoch = dialogEpoch.current;
    const custom = routes.custom;
    setBusy("transit");
    setView("candidate");
    setCandidateTab("route");
    setTransitCallsNotice("");
    try {
      const suggested = await fetchRoute(day.id, {
        order: "suggested", transit: "fetch", maxTransitCalls: transitCallsNeeded,
      });
      if (ticket !== latestRequest.current || epoch !== dialogEpoch.current) return;
      let updatedCustom: DayRouteDto | undefined;
      if (custom) {
        // Preserve removals while applying the new suggestion to the remaining candidate stops.
        const kept = new Set(custom.orderedTripPlaceIds);
        updatedCustom = await fetchRoute(day.id, {
          order: "custom",
          orderedTripPlaceIds: suggested.travelSource !== "straight_line"
            ? suggested.orderedTripPlaceIds.filter((id) => kept.has(id))
            : custom.orderedTripPlaceIds,
        });
        updatedCustom = withDialogTransit(updatedCustom, suggested);
      }
      if (ticket !== latestRequest.current || epoch !== dialogEpoch.current) return;
      setRoutes((current) => ({ ...current, suggested, custom: updatedCustom }));
    } catch (reason) {
      if (ticket !== latestRequest.current || epoch !== dialogEpoch.current) return;
      if (reason instanceof ApiRequestError && reason.code === "transit_calls_changed") {
        try {
          const suggested = await fetchRoute(day.id, { order: "suggested", transit: "cached" });
          if (ticket !== latestRequest.current || epoch !== dialogEpoch.current) return;
          setRoutes((current) => ({ ...current, suggested }));
          setTransitCallsNotice(suggested.transitCallsNeeded > 0
            ? `行程剛變動，需要的額度變成約 ${suggested.transitCallsNeeded} 次，請再按一次。`
            : suggested.transitProvider === "google_routes"
              ? "行程剛變動，目前沒有需要查詢的交通路段。"
              : "行程剛變動，現在可直接使用已查過的交通時間。");
        } catch {
          if (ticket === latestRequest.current && epoch === dialogEpoch.current) {
            setTransitCallsNotice("行程剛變動，暫時無法更新需要的額度，請關閉後重新開啟。");
          }
        }
      } else {
        notify("error", reason instanceof Error ? reason.message : t.dayPlan.couldNotPlan);
      }
    } finally {
      if (ticket === latestRequest.current && epoch === dialogEpoch.current) setBusy(null);
    }
  }

  useEffect(() => {
    latestRequest.current += 1;
    const epoch = ++dialogEpoch.current;
    setRoutes({});
    setView("candidate");
    setBusy(null);
    setTransitCallsNotice("");
    setStayEdit(null);
    setSavedTab("route");
    setCandidateTab("route");
    shapeRequests.current.clear();
    setShapeStates({});
    if (!day) initialRouteRequest.current = null;
    updateDrag(null);
    if (day) void loadRoutes(day.id, epoch);
    return () => {
      dialogEpoch.current += 1;
      latestRequest.current += 1;
    };
  }, [day, loadRoutes]);

  const openDayId = day?.id ?? null;
  useEffect(() => {
    const ticket = ++mapsConfigRequest.current;
    setMapsConfig(null);
    setMapsConfigError("");
    if (!openDayId) {
      setMapsConfigLoading(false);
      return;
    }
    setMapsConfigLoading(true);
    void request<MapsConfigResponse>("/api/maps/config", { parse: parseMapsConfigResponse })
      .then((config) => {
        if (ticket === mapsConfigRequest.current) setMapsConfig(config);
      })
      .catch(() => {
        if (ticket === mapsConfigRequest.current) {
          setMapsConfigError("無法載入 Google 地圖設定，請稍後再試。");
        }
      })
      .finally(() => {
        if (ticket === mapsConfigRequest.current) setMapsConfigLoading(false);
      });
    return () => {
      mapsConfigRequest.current += 1;
    };
  }, [openDayId, request]);

  function close() {
    dialogEpoch.current += 1;
    latestRequest.current += 1;
    initialRouteRequest.current = null;
    shapeRequests.current.clear();
    setShapeStates({});
    setRoutes({});
    setStayEdit(null);
    onClose();
  }

  async function arrange(orderedTripPlaceIds: string[]) {
    if (!day || !candidate) return;
    if (orderedTripPlaceIds.join("\u0000") === candidate.orderedTripPlaceIds.join("\u0000")) return;
    const ticket = ++latestRequest.current;
    const epoch = dialogEpoch.current;
    setBusy("planning");
    setView("candidate");
    try {
      const route = await fetchRoute(day.id, { order: "custom", orderedTripPlaceIds });
      if (ticket !== latestRequest.current || epoch !== dialogEpoch.current) return;
      setRoutes((current) => ({ ...current, custom: withDialogTransit(route, candidate) }));
      setCandidateTab("route");
    } catch (reason) {
      if (ticket === latestRequest.current && epoch === dialogEpoch.current) {
        notify("error", reason instanceof Error ? reason.message : t.dayPlan.couldNotPlan);
      }
    } finally {
      if (ticket === latestRequest.current && epoch === dialogEpoch.current) setBusy(null);
    }
  }

  async function saveArrangement() {
    if (!canArrange) {
      notify("error", t.schedule.ownerOnlyAction);
      return;
    }
    if (!day || !saved || !candidate) return;
    const epoch = dialogEpoch.current;
    const samePlaces = candidate.orderedTripPlaceIds.length === saved.orderedTripPlaceIds.length
      && candidate.orderedTripPlaceIds.every((id) => saved.orderedTripPlaceIds.includes(id));
    const operation = samePlaces ? "place-order" : "arrangement";
    const identity = `${operation}:${day.id}:${candidate.version}:${candidate.orderedTripPlaceIds.join(",")}`;
    setBusy("saving");
    try {
      const options = {
        method: "PUT",
        headers: { "Idempotency-Key": keyFor(identity) },
        body: JSON.stringify({
          orderedTripPlaceIds: candidate.orderedTripPlaceIds,
          expectedVersion: candidate.version,
        }),
      };
      if (samePlaces) {
        await request<{ orderedTripPlaceIds: string[]; version: number }>(
          `/api/trips/${tripId}/days/${day.id}/place-order`,
          options,
        );
      } else {
        await request<TripPlaceListResponse>(
          `/api/trips/${tripId}/days/${day.id}/arrangement`,
          { ...options, parse: parseTripPlaceListResponse },
        );
      }
      actionKeys.current.delete(identity);
      await onOrderSaved();
      if (epoch !== dialogEpoch.current) return;
      notify("success", `已儲存為${day.label}的順序。`);
      // Refresh saved data and the cache-only suggestion; saving never starts paid calls.
      const [current, suggested] = await Promise.all([
        fetchRoute(day.id, { order: "current" }),
        fetchRoute(day.id, { order: "suggested", transit: "cached" }),
      ]);
      if (epoch !== dialogEpoch.current) return;
      const restoreTarget = current.version === suggested.version
        ? retainGoogleSuggestion(routes.suggested, suggested) : suggested;
      setRoutes({
        current,
        suggested: restoreTarget,
        custom: {
          ...(restoreTarget.transitMatrix.length > 0 && restoreTarget.transitProvider
            ? withTransitMatrix(current, restoreTarget.transitMatrix, restoreTarget.transitProvider)
            : withDialogTransit(current, candidate)),
          transitCallsNeeded: suggested.transitCallsNeeded,
          transitCacheDays: suggested.transitCacheDays,
          order: "custom",
        },
      });
      setSavedTab("route");
      setCandidateTab("route");
    } catch (reason) {
      if (epoch !== dialogEpoch.current) return;
      if (reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)) {
        notify("error", t.schedule.ownerOnlyAction);
      } else if (reason instanceof ApiRequestError && reason.code === "conflict") {
        notify("error", t.collaboration.replanDay);
        try {
          const current = await fetchRoute(day.id, { order: "current" });
          if (epoch !== dialogEpoch.current) return;
          setRoutes({ current, custom: { ...current, order: "custom" } });
          setSavedTab("route");
          setCandidateTab("route");
        } catch {
          notify("error", t.dayPlan.couldNotPlan);
        }
      } else {
        notify("error", reason instanceof Error ? reason.message : t.dayPlan.couldNotSaveOrder);
      }
    } finally {
      if (epoch === dialogEpoch.current) setBusy(null);
    }
  }

  function remove(id: string) {
    if (!candidate) return;
    void arrange(candidate.orderedTripPlaceIds.filter((entry) => entry !== id));
  }

  function reorder(id: string, index: number) {
    if (!candidate) return;
    const others = candidate.orderedTripPlaceIds.filter((entry) => entry !== id);
    const at = Math.max(0, Math.min(index, others.length));
    void arrange([...others.slice(0, at), id, ...others.slice(at)]);
  }

  /** Saves through the place sheet's planning endpoint, then re-reads this order's timing from the cache only. */
  async function saveStay(tripPlaceId: string, value: string) {
    if (!day || !candidate || busy !== null) return;
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720) {
      setStayEdit({ tripPlaceId, value, error: "請輸入 15 到 720 分鐘。" });
      return;
    }
    const place = places.find((entry) => entry.id === tripPlaceId);
    if (!place) {
      setStayEdit({ tripPlaceId, value, error: "找不到這個地點的資料，請關閉後重新開啟。" });
      return;
    }
    const epoch = dialogEpoch.current;
    const dayId = day.id;
    const orderedTripPlaceIds = candidate.orderedTripPlaceIds;
    // The endpoint replaces every planning fact, so the others go back unchanged.
    const payload = {
      durationMinutes: minutes,
      effortLevel: place.effortLevel,
      budgetAmountMinor: place.budgetAmountMinor,
      budgetCurrency: place.budgetCurrency,
      notes: place.notes,
      expectedVersion: place.version,
    };
    const identity = `planning:${place.id}:${JSON.stringify(payload)}`;
    setBusy("stay");
    try {
      try {
        await request<TripPlaceResponse>(`/api/trips/${tripId}/trip-places/${place.id}/planning`, {
          method: "PATCH",
          headers: { "Idempotency-Key": keyFor(identity) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceResponse,
        });
      } catch (reason) {
        if (epoch !== dialogEpoch.current) return;
        if (reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)) {
          setStayEdit({ tripPlaceId, value, error: t.schedule.ownerOnlyAction });
        } else if (reason instanceof ApiRequestError && reason.code === "conflict") {
          // The next attempt sends the refreshed version (and a new key, since the payload changes).
          let refreshed = true;
          await onPlaceUpdated().catch(() => { refreshed = false; });
          if (epoch !== dialogEpoch.current) return;
          setStayEdit({ tripPlaceId, value, error: refreshed
            ? "這個地點剛被其他人改過，已讀取最新資料；請再儲存一次。"
            : "這個地點剛被其他人改過，請關閉後重新開啟再改。" });
        } else {
          setStayEdit({ tripPlaceId, value, error: reason instanceof Error && reason.message ? reason.message : "無法儲存停留時間。" });
        }
        return;
      }
      actionKeys.current.delete(identity);
      if (epoch !== dialogEpoch.current) return;
      setStayEdit(null);
      try {
        await onPlaceUpdated();
        // A custom read never calls a transit provider; it only carries the new stay.
        const fresh = await fetchRoute(dayId, { order: "custom", orderedTripPlaceIds });
        if (epoch !== dialogEpoch.current) return;
        const stays = new Map(fresh.stops.map((stop) => [stop.tripPlaceId, stop]));
        const withStays = (route: DayRouteDto | undefined) => route && {
          ...route,
          dayStartMinute: fresh.dayStartMinute,
          fixedMinutes: fresh.fixedMinutes,
          stops: route.stops.map((stop) => {
            const next = stays.get(stop.tripPlaceId);
            return next ? { ...stop, stayMinutes: next.stayMinutes, stayEstimated: next.stayEstimated } : stop;
          }),
        };
        setRoutes((current) => ({
          current: withStays(current.current),
          suggested: withStays(current.suggested),
          custom: withStays(current.custom),
        }));
      } catch {
        if (epoch === dialogEpoch.current) notify("error", "已儲存停留時間，但無法更新回住宿時間；請關閉後重新開啟。");
      }
    } finally {
      if (epoch === dialogEpoch.current) setBusy(null);
    }
  }

  const [drag, setDrag] = useState<{
    id: string;
    startY: number;
    moved: boolean;
    targetIndex: number;
  } | null>(null);
  const dragRef = useRef(drag);

  function updateDrag(next: typeof drag) {
    dragRef.current = next;
    setDrag(next);
  }

  function dropIndex(id: string, y: number) {
    return [...document.querySelectorAll<HTMLElement>(`[data-route-version="candidate"] li.route-stop-draggable`)]
      .filter((row) => row.dataset.tripPlaceId !== id)
      .filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top + box.height / 2 < y;
      }).length;
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) {
    if (busy !== null || event.button !== 0) return;
    event.preventDefault();
    updateDrag({ id, startY: event.clientY, moved: false, targetIndex: index });
    const pointerId = event.pointerId;
    const move = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (moveEvent.pointerId !== pointerId || !current) return;
      const moved = current.moved || Math.abs(moveEvent.clientY - current.startY) > 6;
      updateDrag({
        ...current,
        moved,
        targetIndex: moved ? dropIndex(id, moveEvent.clientY) : current.targetIndex,
      });
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const current = dragRef.current;
      updateDrag(null);
      if (endEvent.type !== "pointerup" || !current?.moved || !candidate) return;
      reorder(id, current.targetIndex);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function dragHandle(id: string, name: string, index: number) {
    return (
      <button
        type="button"
        className="route-drag-handle"
        aria-label={`拖曳「${name}」調整順序；也可用上下鍵`}
        aria-disabled={busy !== null}
        onPointerDown={(event) => startDrag(event, id, index)}
        onKeyDown={(event) => {
          const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
          if (step === 0 || busy !== null) return;
          event.preventDefault();
          reorder(id, Math.max(0, index + step));
        }}
      >
        <GripVertical aria-hidden="true" />
      </button>
    );
  }

  /** Candidate-side stay: read-only text, or (when the member may arrange) a button opening an inline minutes editor. */
  function stayRow(stop: DayRouteDto["stops"][number], editable: boolean) {
    const text = stayText(stop);
    if (!text) return null;
    if (editable && stayEdit?.tripPlaceId === stop.tripPlaceId) {
      const inputId = `${routeViewId}-stay-${stop.tripPlaceId}`;
      const errorId = `${inputId}-error`;
      const minutes = Number(stayEdit.value);
      return (
        <form
          className="route-stay-editor"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void saveStay(stop.tripPlaceId, stayEdit.value);
          }}
        >
          <label htmlFor={inputId}>「{stop.name}」停留時間</label>
          <span className="route-stay-input">
            <input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={15}
              max={720}
              step={15}
              value={stayEdit.value}
              autoFocus
              aria-invalid={stayEdit.error ? true : undefined}
              aria-describedby={stayEdit.error ? errorId : undefined}
              onChange={(event) => {
                const value = event.target.value;
                setStayEdit((current) => current && { ...current, value, error: "" });
              }}
            />
            <span>分鐘</span>
            {Number.isInteger(minutes) && minutes >= 60 ? <span className="route-stay-hint">＝{durationText(minutes)}</span> : null}
          </span>
          <span className="route-stay-actions">
            <button type="button" className="route-link-button" disabled={busy === "stay"} onClick={() => setStayEdit(null)}>取消</button>
            <button type="submit" className="route-stay-save" disabled={busy !== null}>
              <Check aria-hidden="true" /> {busy === "stay" ? "儲存中…" : "儲存停留時間"}
            </button>
          </span>
          {stayEdit.error ? <p id={errorId} role="alert" className="route-stay-error">{stayEdit.error}</p> : null}
        </form>
      );
    }
    if (!editable) {
      return <p className="route-stay-text"><Clock3 aria-hidden="true" />{text}</p>;
    }
    return (
      <button
        type="button"
        className="route-stay-button"
        disabled={busy !== null}
        aria-label={`改「${stop.name}」的停留時間（目前${text}）`}
        onClick={() => setStayEdit({ tripPlaceId: stop.tripPlaceId, value: String(stop.stayMinutes), error: "" })}
      >
        <Clock3 aria-hidden="true" />
        <span>{text}</span>
        <span className="route-stay-edit">改停留時間</span>
      </button>
    );
  }

  function routeList(route: DayRouteDto, editable: boolean, version: "saved" | "candidate") {
    const otherStops = drag?.moved
      ? route.stops.filter((stop) => stop.tripPlaceId !== drag.id)
      : route.stops;
    return (
      <ol className="route-timeline route-distance-list" aria-label={`${route.date} 的地點順序`}>
        <li className="route-stop route-distance-anchor">
          <span className="route-stop-number">起</span>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <strong>{route.startsAt?.name ?? "未設定出發住宿"}</strong>
            {route.startsAt ? <span className="route-stop-meta">住宿出發</span> : null}
          </div>
        </li>
        {route.stops.map((stop, index) => {
          const dragged = drag?.moved && drag.id === stop.tripPlaceId;
          const slot = otherStops.findIndex((entry) => entry.tripPlaceId === stop.tripPlaceId);
          const marker = !drag?.moved || dragged
            ? ""
            : slot === drag.targetIndex
              ? " drop-before"
              : slot === otherStops.length - 1 && drag.targetIndex >= otherStops.length
                ? " drop-after"
                : "";
          return (
            <Fragment key={stop.tripPlaceId}>
              {index > 0 || route.startsAt
                ? legRow(`leg-${stop.tripPlaceId}`, stop.metersFromPrevious, index > 0 ? route.stops[index - 1]! : route.startsAt!, stop,
                  stop.minutesFromPrevious, stop.linesFromPrevious,
                  version === "candidate" && shapeFailed(route, index > 0 ? route.stops[index - 1]!.tripPlaceId : route.startsAt!.placeId, stop.tripPlaceId),
                  version, route.transitProvider, t.dayPlan,
                  version === "candidate" ? shapeBusLikely(route, index > 0 ? route.stops[index - 1]!.tripPlaceId : route.startsAt!.placeId, stop.tripPlaceId) : null)
                : null}
              <li
                data-trip-place-id={stop.tripPlaceId}
                className={`route-stop${editable ? " route-stop-draggable" : ""}${dragged ? " is-dragging" : ""}${marker}`}
              >
                <span className="route-stop-number">{index + 1}</span>
                <span className="route-stop-track" aria-hidden="true" />
                <div className="route-stop-content">
                  <div className="route-stop-title">
                    {editable ? dragHandle(stop.tripPlaceId, stop.name, index) : null}
                    <strong>{stop.name}</strong>
                    {editable ? (
                      <button
                        type="button"
                        className="route-remove-button"
                        disabled={busy !== null}
                        aria-label={`這天不去「${stop.name}」`}
                        onClick={() => remove(stop.tripPlaceId)}
                      >
                        <X aria-hidden="true" /> 這天不去
                      </button>
                    ) : null}
                  </div>
                  {version === "candidate" ? stayRow(stop, editable) : null}
                </div>
              </li>
            </Fragment>
          );
        })}
        {route.stops.length > 0 && route.endsAt ? legRow("leg-end", route.metersToEnd, route.stops.at(-1)!, route.endsAt,
          route.minutesToEnd, route.linesToEnd,
          version === "candidate" && shapeFailed(route, route.stops.at(-1)!.tripPlaceId, route.endsAt.placeId),
          version, route.transitProvider, t.dayPlan,
          version === "candidate" ? shapeBusLikely(route, route.stops.at(-1)!.tripPlaceId, route.endsAt.placeId) : null) : null}
        <li className="route-stop route-distance-anchor">
          <span className="route-stop-number">終</span>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <strong>{route.endsAt?.name ?? "未設定當晚住宿"}</strong>
          </div>
        </li>
      </ol>
    );
  }

  function savedVersion() {
    if (!saved) return null;
    return (
      <section className="route-version" data-active={view === "saved"} data-route-version="saved" aria-label="已儲存的順序">
        <header className="route-version-heading">
          <div>
            <h3>已儲存</h3>
            <span>目前的地點順序</span>
          </div>
          <div className="route-total">
            <span className="route-total-value" data-tone="original">{kilometres(saved.totalMeters)}</span>
          </div>
        </header>
        <div className="route-view-tabs" role="tablist" aria-label="已儲存的檢視方式">
          <button
            id={`${savedTabPrefix}-route-tab`}
            type="button"
            role="tab"
            aria-controls={`${savedTabPrefix}-route-panel`}
            aria-selected={savedTab === "route"}
            tabIndex={savedTab === "route" ? 0 : -1}
            onClick={() => selectRouteTab("saved", "route")}
            onKeyDown={(event) => moveRouteViewTab(event, "route", (next) => selectRouteTab("saved", next), savedTabPrefix)}
          >
            <Route aria-hidden="true" />
            <span>路線</span>
            <Check className="route-selection-mark" aria-hidden="true" />
          </button>
          <button
            id={`${savedTabPrefix}-map-tab`}
            type="button"
            role="tab"
            aria-controls={`${savedTabPrefix}-map-panel`}
            aria-selected={savedTab === "map"}
            tabIndex={savedTab === "map" ? 0 : -1}
            onClick={() => selectRouteTab("saved", "map")}
            onKeyDown={(event) => moveRouteViewTab(event, "map", (next) => selectRouteTab("saved", next), savedTabPrefix)}
          >
            <MapPin aria-hidden="true" />
            <span>Google Map</span>
            <Check className="route-selection-mark" aria-hidden="true" />
          </button>
        </div>
        <div id={`${savedTabPrefix}-route-panel`} role="tabpanel" aria-labelledby={`${savedTabPrefix}-route-tab`} hidden={savedTab !== "route"}>
          {routeList(saved, false, "saved")}
        </div>
        <div id={`${savedTabPrefix}-map-panel`} role="tabpanel" aria-labelledby={`${savedTabPrefix}-map-tab`} hidden={savedTab !== "map"}>
          {savedTab === "map" ? routeMap(saved, "saved") : null}
        </div>
      </section>
    );
  }

  function candidateVersion() {
    if (!candidate || !saved) return null;
    const arranged = Boolean(routes.custom);
    const rawBaseline = removedIds.length === 0
      ? saved : baseline?.key === baselineKey ? baseline.route : null;
    const comparedWith = rawBaseline && transitSource
      ? withTransitMatrix(rawBaseline, transitSource.transitMatrix, transitSource.transitProvider!) : rawBaseline;
    const comparisonPending = removedIds.length > 0 && baseline?.key !== baselineKey;
    const delta = comparedWith
      ? candidateDelta(
        comparedWith,
        candidate,
        arranged || removedIds.length > 0 ? "和原本順序一樣長" : "已是最短",
      )
      : null;
    const removedNames = removedIds.map((id) => saved.stops.find((stop) => stop.tripPlaceId === id)?.name ?? "地點");
    const returnEstimate = estimateDayReturn(candidate);
    const returnText = returnEstimate ? dayReturnLine(returnEstimate) : null;
    return (
      <section className="route-version" data-active={view === "candidate"} data-route-version="candidate" aria-label="可以儲存的順序">
        <header className="route-version-heading">
          <div>
            <h3>{arranged ? "我調整的" : suggestedLabel}</h3>
            <span>預覽中・尚未儲存</span>
          </div>
          <div className="route-total" aria-live="polite">
            {candidate.totalMinutes !== null ? <span className="route-total-value">約 {candidate.totalMinutes} 分鐘</span> : null}
            <span key={`value-${candidate.totalMeters}`} className="route-total-value" data-tone={delta?.tone ?? "original"}>
              {kilometres(candidate.totalMeters)}
            </span>
            {delta ? (
              <span key={`delta-${candidate.totalMeters}`} className="route-total-delta" data-tone={delta.tone}>{delta.text}</span>
            ) : null}
            {removedIds.length > 0 ? (
              <span className="route-total-basis">
                {comparisonPending
                  ? "正在計算比較基準…"
                  : comparedWith
                    ? `與已儲存順序（不含${removedNames.map((name) => `「${name}」`).join("、")}）相比`
                    : "無法取得比較基準"}
              </span>
            ) : null}
          </div>
        </header>
        {returnText ? (
          <div className="route-return">
            <p className="route-return-line" aria-live="polite">
              <strong>{returnText.line}</strong>
              {returnText.note ? <span>{returnText.note}</span> : null}
            </p>
            {canArrange && openDayOverride ? (
              <button
                type="button"
                className="route-link-button"
                disabled={busy !== null}
                onClick={() => {
                  // One dialog at a time: this sheet replaces the route dialog, like editing a place from the planner.
                  close();
                  openDayOverride();
                }}
              >
                調整這天時間
              </button>
            ) : null}
          </div>
        ) : null}
        {transitCallsNeeded > 0 ? (
          <button
            type="button"
            className="route-transit-action"
            disabled={busy !== null}
            onClick={() => void fetchTransitSuggestion()}
          >
            <Route aria-hidden="true" />
            {busy === "transit" ? "查詢中…" : candidate.transitProvider === "google_routes"
              ? `用大眾運輸時間排（約 ${transitCallsNeeded} 次）`
              : `用電車時間排（約 ${transitCallsNeeded} 次額度）`}
          </button>
        ) : null}
        {transitCallsNotice ? <p role="status" className="route-version-note">{transitCallsNotice}</p> : null}
        {candidate.transitCacheDays !== null && candidate.travelSource === "navitime" ? (
          <p className="route-version-note">行程沒變，使用 {candidate.transitCacheDays} 天內查過的交通時間。</p>
        ) : null}
        {busy === "transit" ? (
          <div className="route-shapes-loading">
            <PlaceListSkeleton label="正在查詢缺少的交通時間" rows={2} />
          </div>
        ) : null}
        <div className="route-view-tabs" role="tablist" aria-label={`${arranged ? "我調整的" : suggestedLabel}檢視方式`}>
          <button
            id={`${candidateTabPrefix}-route-tab`}
            type="button"
            role="tab"
            aria-controls={`${candidateTabPrefix}-route-panel`}
            aria-selected={candidateTab === "route"}
            tabIndex={candidateTab === "route" ? 0 : -1}
            onClick={() => selectRouteTab("candidate", "route")}
            onKeyDown={(event) => moveRouteViewTab(event, "route", (next) => selectRouteTab("candidate", next), candidateTabPrefix)}
          >
            <Route aria-hidden="true" />
            <span>路線</span>
            <Check className="route-selection-mark" aria-hidden="true" />
          </button>
          <button
            id={`${candidateTabPrefix}-map-tab`}
            type="button"
            role="tab"
            aria-controls={`${candidateTabPrefix}-map-panel`}
            aria-selected={candidateTab === "map"}
            tabIndex={candidateTab === "map" ? 0 : -1}
            onClick={() => selectRouteTab("candidate", "map")}
            onKeyDown={(event) => moveRouteViewTab(event, "map", (next) => selectRouteTab("candidate", next), candidateTabPrefix)}
          >
            <MapPin aria-hidden="true" />
            <span>Google Map</span>
            <Check className="route-selection-mark" aria-hidden="true" />
          </button>
        </div>
        <div id={`${candidateTabPrefix}-route-panel`} role="tabpanel" aria-labelledby={`${candidateTabPrefix}-route-tab`} hidden={candidateTab !== "route"}>
          <p className="route-version-note">
            {arranged ? "從目前順序調整；拖曳即可再改。"
              : candidate.travelSource !== "straight_line"
                ? `依 ${providerName} 交通時間排序；每段都以當地當天 09:00 出發估算，不是到站時間表。`
                : "只依地點間的直線距離排序。"}
          </p>
          {arranged && routes.suggested ? (
            <button
              type="button"
              className="route-link-button route-reset"
              disabled={busy !== null}
              onClick={() => setRoutes((current) => ({ ...current, custom: undefined }))}
            >
              <RotateCcw aria-hidden="true" /> 還原成{suggestedLabel}
            </button>
          ) : null}
          {routeList(candidate, canArrange, "candidate")}
        </div>
        <div id={`${candidateTabPrefix}-map-panel`} role="tabpanel" aria-labelledby={`${candidateTabPrefix}-map-tab`} hidden={candidateTab !== "map"}>
          {candidateTab === "map" ? routeMap(candidate, "candidate") : null}
        </div>
      </section>
    );
  }

  const unchanged = saved && candidate
    ? saved.orderedTripPlaceIds.join("\u0000") === candidate.orderedTripPlaceIds.join("\u0000")
    : true;

  const versionColumns = (
    <div className="route-versions">
      {savedVersion()}
      {candidateVersion()}
    </div>
  );

  const summary = saved
    ? {
      headline: `${saved.stops.length} 個地點`,
      note: candidate && candidate.travelSource !== "straight_line"
        ? `${providerName} 交通時間以當地 09:00 估算；公里數仍是直線距離${missesLeg(saved) || missesLeg(candidate) ? "；缺少資料的路段另標估計" : ""}`
        : `比的是直線距離，不是實際路程${missesLeg(saved) || (candidate && missesLeg(candidate)) ? "；不含缺少座標的路段" : ""}`,
    }
    : null;

  return (
    <Dialog open={day !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="route-dialog max-[599px]:translate-x-0 max-[599px]:translate-y-0" showCloseButton>
        <DialogHeader className="route-page-heading">
          <DialogTitle>{t.dayPlan.title(day?.label ?? "", day?.date ?? "")}</DialogTitle>
          <DialogDescription>{t.dayPlan.draftNotice}</DialogDescription>
        </DialogHeader>

        {!canArrange ? <p className="route-status">{t.schedule.ownerOnly}</p> : null}
        {busy === "planning" ? <p role="status" className="route-status">{t.dayPlan.planning}</p> : null}
        {routes.suggested?.travelNotice ? <p role="status" className="route-status">
          {routes.suggested.travelNotice === "navitime_quota" || routes.suggested.travelNotice === "transit_quota"
            ? `${providerName} 的交通查詢額度已用完，這次先依直線距離排。每段仍可點 Google Maps 查看走法。`
            : `目前無法取得 ${providerName} 交通時間，這次先依直線距離排。每段仍可點 Google Maps 查看走法。`}
        </p> : null}

        {saved ? (
          <div className="route-comparison">
            <div className="route-distance-summary" aria-live="polite">
              <Route aria-hidden="true" />
              <div>
                <strong>{summary?.headline}</strong>
                <span>{summary?.note}</span>
              </div>
            </div>

            <div className="route-segments" role="tablist" aria-label="切換查看順序">
              <button type="button" role="tab" aria-selected={view === "candidate"} disabled={!candidate} onClick={() => setView("candidate")}>
                <GripVertical aria-hidden="true" />
                <span>{routes.custom ? "我調整的" : suggestedLabel}</span>
                <Check className="route-selection-mark" aria-hidden="true" />
              </button>
              <button type="button" role="tab" aria-selected={view === "saved"} onClick={() => setView("saved")}>
                <MapPin aria-hidden="true" />
                <span>已儲存</span>
                <Check className="route-selection-mark" aria-hidden="true" />
              </button>
            </div>

            {versionColumns}
          </div>
        ) : null}

        <DialogFooter hidden={!saved} className="route-actionbar">
          <Button variant="outline" size="lg" disabled={busy === "saving"} onClick={close}>
            保留已儲存順序
          </Button>
          {canArrange ? (
            <Button
              size="lg"
              disabled={busy !== null || !candidate || unchanged}
              onClick={() => void saveArrangement()}
            >
              <Check aria-hidden="true" /> {busy === "saving" ? t.dayPlan.saving : `儲存為${day?.label ?? "這天"}的安排`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
