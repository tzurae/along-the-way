import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import "./place-filters.css";

/** What a list row exposes to filtering; both 口袋名單 and AI 建議 map their places to this. */
export interface FilterablePlace {
  id: string;
  name: string;
  /** Plain-language state as shown on the row, e.g. 待排日期 / 已排入行程 / 待討論. */
  status: string;
  typeLabel: string;
  area: string | null;
  /** The signed-in member liked it. */
  mine: boolean;
}

type Group = "status" | "type" | "area" | "mine";
interface Facet {
  key: string;
  group: Group;
  label: string;
  count: number;
}

const MINE_KEY = "mine:yes";

/** Small caption before each chip group so 「待排日期」 reads as a state and 「東山區」 as an area. */
const GROUP_LABEL: Record<Group, string> = { mine: "", status: "狀態", type: "類型", area: "地區" };
/** One row per group (我按過讚 rides with 狀態), so a long group wraps inside its own row. */
const ROWS: Group[][] = [["mine", "status"], ["type"], ["area"]];
/** Areas come from free-text addresses and can run to dozens; show the most common first. */
const AREA_PREVIEW = 6;

interface StoredFilters { query: string; selected: string[] }

function readStoredFilters(storageKey: string): StoredFilters {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (value && typeof value === "object") {
      const { query, selected } = value as Partial<StoredFilters>;
      return {
        query: typeof query === "string" ? query : "",
        selected: Array.isArray(selected) ? selected.filter((key): key is string => typeof key === "string") : [],
      };
    }
  } catch {
    // Unavailable storage or a corrupt entry: start unfiltered.
  }
  return { query: "", selected: [] };
}

/**
 * Search plus quick chips for a place list. Within a group chips are OR (two areas), across groups
 * AND (待排日期 in 東山區). Chips that match nothing or everything are not offered.
 * The search and chips are kept in localStorage under `storageKey`, so a reload keeps them.
 */
export function usePlaceFilters(places: FilterablePlace[], storageKey: string) {
  const [stored, setStored] = useState(() => ({ key: storageKey, ...readStoredFilters(storageKey) }));
  // Another trip or list reuses this component: load that list's own filters.
  const current = stored.key === storageKey ? stored : { key: storageKey, ...readStoredFilters(storageKey) };
  if (current !== stored) setStored(current);
  const query = current.query;
  const selected = useMemo(() => new Set(current.selected), [current.selected]);
  const setQuery = (next: string) => setStored((value) => ({ ...value, query: next }));
  const setSelected = (update: (value: Set<string>) => Set<string>) =>
    setStored((value) => ({ ...value, selected: [...update(new Set(value.selected))] }));

  useEffect(() => {
    try {
      if (stored.query === "" && stored.selected.length === 0) window.localStorage.removeItem(stored.key);
      else window.localStorage.setItem(stored.key, JSON.stringify({ query: stored.query, selected: stored.selected }));
    } catch {
      // Storage full or blocked: filters still work for this page view.
    }
  }, [stored]);

  const facets = useMemo(() => {
    const counts = new Map<string, Facet>();
    const add = (group: Group, label: string) => {
      const key = `${group}:${label}`;
      const current = counts.get(key);
      counts.set(key, { key, group, label, count: (current?.count ?? 0) + 1 });
    };
    for (const place of places) {
      add("status", place.status);
      add("type", place.typeLabel);
      if (place.area) add("area", place.area);
      if (place.mine) counts.set(MINE_KEY, { key: MINE_KEY, group: "mine", label: "我按過讚", count: (counts.get(MINE_KEY)?.count ?? 0) + 1 });
    }
    // Only values that narrow the list appear, each with its count: nothing with 0 places, and
    // nothing every place shares, since choosing it would change nothing.
    const order: Group[] = ["mine", "status", "type", "area"];
    return [...counts.values()].filter((facet) => facet.count < places.length).sort((left, right) =>
      order.indexOf(left.group) - order.indexOf(right.group) || right.count - left.count || left.label.localeCompare(right.label));
  }, [places]);

  const visibleIds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const byGroup = new Map<Group, Set<string>>();
    // A remembered chip whose value no longer occurs (place removed or renamed) does not filter.
    const offered = new Set(facets.map((facet) => facet.key));
    for (const key of selected) {
      if (!offered.has(key)) continue;
      const group = key.slice(0, key.indexOf(":")) as Group;
      byGroup.set(group, new Set([...(byGroup.get(group) ?? []), key]));
    }
    const keysOf = (place: FilterablePlace): Record<Group, string[]> => ({
      status: [`status:${place.status}`],
      type: [`type:${place.typeLabel}`],
      area: place.area ? [`area:${place.area}`] : [],
      mine: place.mine ? [MINE_KEY] : [],
    });
    return new Set(places.filter((place) => {
      if (needle && !place.name.toLocaleLowerCase().includes(needle) && !(place.area ?? "").toLocaleLowerCase().includes(needle)) return false;
      const keys = keysOf(place);
      for (const [group, wanted] of byGroup) {
        if (!keys[group].some((key) => wanted.has(key))) return false;
      }
      return true;
    }).map((place) => place.id));
  }, [places, query, selected, facets]);

  return {
    query,
    setQuery,
    selected,
    facets,
    visibleIds,
    active: query.trim() !== "" || [...selected].some((key) => facets.some((facet) => facet.key === key)),
    toggle: (key: string) => setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    }),
    clear: () => setStored((value) => ({ ...value, query: "", selected: [] })),
  };
}

export function PlaceFilterBar({ filters, total, label }: {
  filters: ReturnType<typeof usePlaceFilters>;
  total: number;
  /** What is being searched, for the input's accessible name. */
  label: string;
}) {
  const shown = filters.visibleIds.size;
  const [areasOpen, setAreasOpen] = useState(false);
  return (
    <div className="place-filters" role="search" aria-label={label}>
      <label className="place-filters__search">
        <Search aria-hidden="true" className="size-4" />
        <input
          type="search"
          value={filters.query}
          placeholder="搜尋名稱或區域"
          aria-label={label}
          onChange={(event) => filters.setQuery(event.target.value)}
        />
        {filters.query ? (
          <button type="button" aria-label="清除搜尋" onClick={() => filters.setQuery("")}><X aria-hidden="true" className="size-4" /></button>
        ) : null}
      </label>
      <div className="place-filters__chips" role="group" aria-label="快速篩選">
        {ROWS.map((groups) => {
          const facets = filters.facets.filter((facet) => groups.includes(facet.group));
          if (facets.length === 0) return null;
          const label = groups.map((group) => GROUP_LABEL[group]).find(Boolean);
          const collapsible = groups.includes("area") && facets.length > AREA_PREVIEW + 1;
          // Collapsed: the most common areas plus any already selected, so a chosen chip never hides.
          const visible = collapsible && !areasOpen
            ? facets.filter((facet, index) => index < AREA_PREVIEW || filters.selected.has(facet.key))
            : facets;
          return (
            <div key={groups.join()} className="place-filters__row">
              {label ? <span className="place-filters__group">{label}</span> : null}
              <div className="place-filters__row-chips">
                {visible.map((facet) => (
                  <button
                    key={facet.key}
                    type="button"
                    className="place-filters__chip"
                    aria-pressed={filters.selected.has(facet.key)}
                    title={facet.label}
                    onClick={() => filters.toggle(facet.key)}
                  >
                    <span className="place-filters__label">{facet.label}</span>
                    <span className="place-filters__count">{facet.count}</span>
                  </button>
                ))}
                {collapsible ? (
                  <button
                    type="button"
                    className="place-filters__more"
                    aria-expanded={areasOpen}
                    onClick={() => setAreasOpen((open) => !open)}
                  >
                    {areasOpen ? "收起地區" : `更多地區 +${facets.length - visible.length}`}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {filters.active ? (
        <p className="place-filters__summary" role="status">
          顯示 {shown}／{total} 個地點
          <button type="button" onClick={filters.clear}>清除篩選</button>
        </p>
      ) : null}
    </div>
  );
}

/** Shown in place of the list when the filters match nothing. */
export function PlaceFilterEmpty({ onClear }: { onClear(): void }) {
  return (
    <div className="place-filters__empty">
      <p>沒有符合的地點</p>
      <button type="button" className="pd-secondary" onClick={onClear}>清除篩選</button>
    </div>
  );
}

/** The ward, city, town or village for filters and rows, written the zh-TW way (区 → 區). */
export function placeArea(address: string | null): string | null {
  return addressArea(address)?.replace(/区/gu, "區") ?? null;
}

/**
 * Derive only a Japanese municipality-level area. Japanese addresses are parsed
 * structurally: remove the country/postal prefix, cross the prefecture boundary,
 * then read a municipality and its optional ward. 市/町/村 are not delimiters:
 * they can be part of the real administrative name (四日市市, 中村区).
 * Romanized addresses normalize Ward/-ku/City/Town/District components. Country
 * names, postal codes and street text are never fallback labels.
 */
function addressArea(address: string | null): string | null {
  if (!address) return null;
  const compact = address.replace(/[\s　]/gu, "")
    .replace(/^(?:(?:日本)|(?:〒?\d{3}-?\d{4}))+/u, "");
  const prefecture = compact.match(/^(?:東京都|北海道|京都府|大阪府|.{2,3}?県)(.+)$/u);
  const administrative = prefecture?.[1] ?? compact;
  const cityWard = administrative.match(/^(.+市)(.+?[区區])/u)?.[2];
  if (cityWard) return cityWard;
  const city = administrative.match(/^(.+市)/u)?.[1];
  if (city) return city;
  const districtEnd = administrative.indexOf("郡");
  const rural = districtEnd >= 0 ? administrative.slice(districtEnd + 1) : administrative;
  const townOrVillage = rural.match(/^(.+[町村])/u)?.[1];
  if (townOrVillage) return townOrVillage;
  const specialWard = administrative.match(/^(.+?[区區])/u)?.[1];
  if (specialWard) return specialWard;

  const parts = address.split(/[,，]/).map((part) =>
    part.trim().replace(/\s+(?:〒\s*)?\d{3}-?\d{4}.*$/u, "").trim(),
  ).filter((part) =>
    part !== ""
    && !/^(?:Japan|日本)$/iu.test(part)
    && !/^(?:〒\s*)?\d{3}-?\d{4}$/u.test(part));
  const area = parts.find((part) => /(?:\s+Ward|-ku|\s+(?:City|Town|District))$/iu.test(part));
  return area?.replace(/(?:\s+Ward|-ku|\s+(?:City|Town|District))$/iu, "").trim() || null;
}
