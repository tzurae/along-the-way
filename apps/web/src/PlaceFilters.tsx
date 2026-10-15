import { useMemo, useState } from "react";
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

/**
 * Search plus quick chips for a place list. Within a group chips are OR (two areas), across groups
 * AND (待排日期 in 東山區). Chips that match nothing or everything are not offered.
 */
export function usePlaceFilters(places: FilterablePlace[]) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
    // Only values that occur appear, each with its count; nothing with 0 places is offered.
    const order: Group[] = ["mine", "status", "type", "area"];
    return [...counts.values()].sort((left, right) =>
      order.indexOf(left.group) - order.indexOf(right.group) || right.count - left.count || left.label.localeCompare(right.label));
  }, [places]);

  const visibleIds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const byGroup = new Map<Group, Set<string>>();
    for (const key of selected) {
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
  }, [places, query, selected]);

  return {
    query,
    setQuery,
    selected,
    facets,
    visibleIds,
    active: query.trim() !== "" || selected.size > 0,
    toggle: (key: string) => setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    }),
    clear: () => { setQuery(""); setSelected(new Set()); },
  };
}

export function PlaceFilterBar({ filters, total, label }: {
  filters: ReturnType<typeof usePlaceFilters>;
  total: number;
  /** What is being searched, for the input's accessible name. */
  label: string;
}) {
  const shown = filters.visibleIds.size;
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
        {filters.facets.map((facet, index) => (
          <span key={facet.key} className="place-filters__chip-slot">
            {index === 0 || filters.facets[index - 1]!.group !== facet.group
              ? GROUP_LABEL[facet.group] ? <span className="place-filters__group">{GROUP_LABEL[facet.group]}</span> : null
              : null}
            <button
              type="button"
              className="place-filters__chip"
              aria-pressed={filters.selected.has(facet.key)}
              onClick={() => filters.toggle(facet.key)}
            >
              {facet.label}
              <span className="place-filters__count">{facet.count}</span>
            </button>
          </span>
        ))}
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

/**
 * The ward or city of an address, for grouping places by area: 「…東山区清水1丁目…」→「東山区」,
 * 「… Higashiyama Ward, Kyoto, 605-0862」→「Higashiyama Ward」. Null when nothing recognisable.
 */
export function placeArea(address: string | null): string | null {
  if (!address) return null;
  // Japanese form: the ward after the city (京都市東山区 → 東山区), else the city or town itself.
  const ward = address.match(/市([^\s、,，市区]+区)/u)?.[1] ?? address.match(/([^\s、,，都道府県〒\d-]+[市町村])/u)?.[1];
  if (ward) return ward;
  const parts = address.split(/[,，]/).map((part) => part.trim()).filter((part) => part && !/^[〒\d\s-]+$/u.test(part) && !/^(Japan|日本)$/u.test(part));
  const english = parts.find((part) => /\b(Ward|ku|City|Town|District)\b/i.test(part));
  if (english) return english.replace(/\s*\d{3}-?\d{4}.*$/u, "");
  return parts.length >= 2 ? parts[parts.length - 2]! : null;
}
