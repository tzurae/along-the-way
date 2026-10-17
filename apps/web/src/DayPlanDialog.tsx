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
  type CreateDayRouteInput,
  type DayRouteDto,
  type DayRouteOrder,
  type DayRouteResponse,
} from "@along-the-way/contracts/day-plans";
import {
  parseTripPlaceListResponse,
  type TripPlaceListResponse,
} from "@along-the-way/contracts/trip-places";
import { parseMapsConfigResponse, type MapsConfigResponse } from "@along-the-way/contracts/maps";
import { AdvancedMarker, APIProvider, Map as GoogleMap, Pin, useMap } from "@vis.gl/react-google-maps";
import { Check, GripVertical, MapPin, RotateCcw, Route, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "./i18n";
import { ApiRequestError } from "./api-error";
import { notify } from "./AppToaster";
import { googleMapsDirectionsUrl } from "./google-maps";

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
  const difference = candidate.totalMeters - baseline.totalMeters;
  if (Math.abs(difference) < 100) return { tone: "same", text: sameText } as const;
  return difference < 0
    ? { tone: "shorter", text: `↓ 少 ${kilometres(-difference)}` } as const
    : { tone: "longer", text: `↑ 多 ${kilometres(difference)}` } as const;
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

function RouteMapOverlay({
  points,
  visibilityRevision,
}: {
  points: RouteMapPoint[];
  visibilityRevision: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend(point.position));
    map.fitBounds(bounds, 48);
  }, [map, points, visibilityRevision]);

  useEffect(() => {
    if (!map) return;
    const polyline = new google.maps.Polyline({
      map,
      path: points.map((point) => point.position),
      geodesic: false,
      strokeColor: "#d37551",
      strokeOpacity: 0.9,
      strokeWeight: 4,
    });
    return () => polyline.setMap(null);
  }, [map, points]);

  return null;
}

function RouteMapView({
  date,
  points,
  mapId,
  visibilityRevision,
}: {
  date: string;
  points: RouteMapPoint[];
  mapId: string | null;
  visibilityRevision: boolean;
}) {
  return (
    <div className="route-map-shell" aria-label={`${date} 的路線地圖`}>
      <GoogleMap
        className="route-map"
        defaultCenter={points[0]!.position}
        defaultZoom={12}
        gestureHandling="cooperative"
        mapId={mapId ?? "DEMO_MAP_ID"}
      >
        <RouteMapOverlay points={points} visibilityRevision={visibilityRevision} />
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
  browserKey,
  mapId,
  request,
  visibilityRevision,
  onRetry,
  onShowRoute,
}: {
  route: DayRouteDto;
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
      <RouteMapView date={route.date} points={points} mapId={mapId} visibilityRevision={visibilityRevision} />
    </APIProvider>
  );
}

function RouteMapPanel({
  route,
  config,
  loading,
  error,
  request,
  visibilityRevision,
  onShowRoute,
}: {
  route: DayRouteDto;
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

/**
 * The straight-line distance between the row above and the row below, drawn on the connecting
 * line, with a link to Google Maps directions for the same two points so travellers compare real
 * modes and times there; this app does not estimate travel time. Only rendered when both ends
 * exist; null metres mean one end lacks coordinates, which also leaves no link to build.
 */
function legRow(key: string, meters: number | null, from: LegEnd, to: LegEnd) {
  const distance = meters === null ? "缺少座標" : meters < 1_000 ? `${meters} 公尺` : `${(meters / 1_000).toFixed(1)} 公里`;
  const directions = googleMapsDirectionsUrl(from, to);
  return (
    <li key={key} className="route-leg">
      <span aria-hidden="true" />
      <span className="route-leg-track" aria-hidden="true" />
      <span className="route-leg-text">
        <span><span aria-hidden="true">↓ </span>{distance}</span>
        {directions ? (
          <a
            className="route-leg-directions"
            href={directions}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`在 Google Maps 查看「${from.name}」到「${to.name}」的交通方式（另開新分頁）`}
          >
            <MapPin aria-hidden="true" /> Google Maps
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
}: {
  tripId: string;
  day: PlannedDay | null;
  /** Owner, or an editor the owner allows to arrange the itinerary. */
  canArrange: boolean;
  request: JsonRequest;
  onClose(): void;
  onOrderSaved(): Promise<void>;
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
  const [busy, setBusy] = useState<"planning" | "saving" | null>(null);
  const latestRequest = useRef(0);
  const mapsConfigRequest = useRef(0);
  const dialogEpoch = useRef(0);
  const actionKeys = useRef(new Map<string, string>());

  const saved = routes.current ?? null;
  const candidate = routes.custom ?? routes.suggested ?? null;

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
  // without those places, read from the same straight-line route endpoint as every other order.
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
      const [current, suggested] = await Promise.all([
        fetchRoute(dayId, { order: "current" }),
        fetchRoute(dayId, { order: "suggested" }),
      ]);
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

  useEffect(() => {
    latestRequest.current += 1;
    const epoch = ++dialogEpoch.current;
    setRoutes({});
    setView("candidate");
    setBusy(null);
    setSavedTab("route");
    setCandidateTab("route");
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
      setRoutes((current) => ({ ...current, custom: route }));
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
      await loadRoutes(day.id, epoch);
    } catch (reason) {
      if (epoch !== dialogEpoch.current) return;
      if (reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)) {
        notify("error", t.schedule.ownerOnlyAction);
      } else if (reason instanceof ApiRequestError && reason.code === "conflict") {
        notify("error", t.collaboration.replanDay);
        await loadRoutes(day.id, epoch);
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

  function routeList(route: DayRouteDto, editable: boolean) {
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
                ? legRow(`leg-${stop.tripPlaceId}`, stop.metersFromPrevious, index > 0 ? route.stops[index - 1]! : route.startsAt!, stop)
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
                </div>
              </li>
            </Fragment>
          );
        })}
        {route.stops.length > 0 && route.endsAt ? legRow("leg-end", route.metersToEnd, route.stops.at(-1)!, route.endsAt) : null}
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
            onClick={() => setSavedTab("route")}
            onKeyDown={(event) => moveRouteViewTab(event, "route", setSavedTab, savedTabPrefix)}
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
            onClick={() => setSavedTab("map")}
            onKeyDown={(event) => moveRouteViewTab(event, "map", setSavedTab, savedTabPrefix)}
          >
            <MapPin aria-hidden="true" />
            <span>Google Map</span>
            <Check className="route-selection-mark" aria-hidden="true" />
          </button>
        </div>
        <div id={`${savedTabPrefix}-route-panel`} role="tabpanel" aria-labelledby={`${savedTabPrefix}-route-tab`} hidden={savedTab !== "route"}>
          {routeList(saved, false)}
        </div>
        <div id={`${savedTabPrefix}-map-panel`} role="tabpanel" aria-labelledby={`${savedTabPrefix}-map-tab`} hidden={savedTab !== "map"}>
          {savedTab === "map" ? (
            <RouteMapPanel
              route={saved}
              config={mapsConfig}
              loading={mapsConfigLoading}
              error={mapsConfigError}
              request={request}
              visibilityRevision={view === "saved"}
              onShowRoute={() => setSavedTab("route")}
            />
          ) : null}
        </div>
      </section>
    );
  }

  function candidateVersion() {
    if (!candidate || !saved) return null;
    const arranged = Boolean(routes.custom);
    const comparedWith = removedIds.length === 0
      ? saved
      : baseline?.key === baselineKey ? baseline.route : null;
    const comparisonPending = removedIds.length > 0 && baseline?.key !== baselineKey;
    const delta = comparedWith
      ? candidateDelta(
        comparedWith,
        candidate,
        arranged || removedIds.length > 0 ? "和原本順序一樣長" : "已是最短",
      )
      : null;
    const removedNames = removedIds.map((id) => saved.stops.find((stop) => stop.tripPlaceId === id)?.name ?? "地點");
    return (
      <section className="route-version" data-active={view === "candidate"} data-route-version="candidate" aria-label="可以儲存的順序">
        <header className="route-version-heading">
          <div>
            <h3>{arranged ? "我調整的" : "依直線距離排"}</h3>
            <span>預覽中・尚未儲存</span>
          </div>
          <div className="route-total" aria-live="polite">
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
        <div className="route-view-tabs" role="tablist" aria-label={`${arranged ? "我調整的" : "依直線距離排"}檢視方式`}>
          <button
            id={`${candidateTabPrefix}-route-tab`}
            type="button"
            role="tab"
            aria-controls={`${candidateTabPrefix}-route-panel`}
            aria-selected={candidateTab === "route"}
            tabIndex={candidateTab === "route" ? 0 : -1}
            onClick={() => setCandidateTab("route")}
            onKeyDown={(event) => moveRouteViewTab(event, "route", setCandidateTab, candidateTabPrefix)}
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
            onClick={() => setCandidateTab("map")}
            onKeyDown={(event) => moveRouteViewTab(event, "map", setCandidateTab, candidateTabPrefix)}
          >
            <MapPin aria-hidden="true" />
            <span>Google Map</span>
            <Check className="route-selection-mark" aria-hidden="true" />
          </button>
        </div>
        <div id={`${candidateTabPrefix}-route-panel`} role="tabpanel" aria-labelledby={`${candidateTabPrefix}-route-tab`} hidden={candidateTab !== "route"}>
          <p className="route-version-note">
            {arranged ? "從建議順序調整；拖曳即可再改。" : "只依地點間的直線距離排序。"}
          </p>
          {arranged ? (
            <button
              type="button"
              className="route-link-button route-reset"
              disabled={busy !== null}
              onClick={() => setRoutes((current) => ({ ...current, custom: undefined }))}
            >
              <RotateCcw aria-hidden="true" /> 還原成依直線距離排
            </button>
          ) : null}
          {routeList(candidate, canArrange)}
        </div>
        <div id={`${candidateTabPrefix}-map-panel`} role="tabpanel" aria-labelledby={`${candidateTabPrefix}-map-tab`} hidden={candidateTab !== "map"}>
          {candidateTab === "map" ? (
            <RouteMapPanel
              route={candidate}
              config={mapsConfig}
              loading={mapsConfigLoading}
              error={mapsConfigError}
              request={request}
              visibilityRevision={view === "candidate"}
              onShowRoute={() => setCandidateTab("route")}
            />
          ) : null}
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
      note: `比的是直線距離，不是實際路程${missesLeg(saved) || (candidate && missesLeg(candidate)) ? "；不含缺少座標的路段" : ""}`,
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
                <span>{routes.custom ? "我調整的" : "依直線距離排"}</span>
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
