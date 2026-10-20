export interface GeoPoint {
  id: string;
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
// Exhaustive search is exact and fast up to 8 stops (8! = 40,320 orders).
const EXHAUSTIVE_LIMIT = 8;
export const TWO_OPT_MAX_PASSES = 12;
type RouteDistance = (from: GeoPoint, to: GeoPoint) => number;

export function straightLineMeters(a: GeoPoint, b: GeoPoint) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The route the day dialog shows: from `start` (the morning's lodging) through the stops in order
 * to `end` (the night's lodging); a missing end adds nothing. The same lodging at both ends makes
 * a round trip.
 */
export function routeLength(order: GeoPoint[], start: GeoPoint | null, end: GeoPoint | null, distance: RouteDistance = straightLineMeters) {
  if (order.length === 0) return 0;
  let total = start ? distance(start, order[0]!) : 0;
  for (let index = 1; index < order.length; index += 1) total += distance(order[index - 1]!, order[index]!);
  return total + (end ? distance(order.at(-1)!, end) : 0);
}


function improveByTwoOpt(order: GeoPoint[], start: GeoPoint | null, end: GeoPoint | null, distance: RouteDistance, directed: boolean) {
  const best = [...order];
  for (let pass = 0; pass < TWO_OPT_MAX_PASSES; pass += 1) {
    let improved = false;
    for (let from = 0; from < best.length - 1; from += 1) {
      for (let to = from + 1; to < best.length; to += 1) {
        const before = from === 0 ? start : best[from - 1]!;
        const after = to === best.length - 1 ? end : best[to + 1]!;
        const first = best[from]!;
        const last = best[to]!;
        let removed = (before ? distance(before, first) : 0) + (after ? distance(last, after) : 0);
        let added = (before ? distance(before, last) : 0) + (after ? distance(first, after) : 0);
        // Transit is directed: reversing a segment also changes every internal edge.
        if (directed) {
          for (let index = from; index < to; index += 1) {
            removed += distance(best[index]!, best[index + 1]!);
            added += distance(best[index + 1]!, best[index]!);
          }
        }
        if (added + 1e-6 >= removed) continue;
        for (let left = from, right = to; left < right; left += 1, right -= 1) {
          [best[left], best[right]] = [best[right]!, best[left]!];
        }
        improved = true;
      }
    }
    if (!improved) break;
  }
  return best;
}

/** Straight-line suggestions retain the existing eight-stop exact search. */
export function orderByStraightLine(
  stops: GeoPoint[],
  start: GeoPoint | null,
  end: GeoPoint | null,
  distance: RouteDistance = straightLineMeters,
): string[] {
  return orderByCost(stops, start, end, distance, EXHAUSTIVE_LIMIT, false);
}

/** Exact permutations up to the limit, then nearest neighbour + directed-aware 2-opt. */
export function orderByCost(
  stops: GeoPoint[],
  start: GeoPoint | null,
  end: GeoPoint | null,
  distance: RouteDistance,
  exhaustiveLimit: number,
  directed: boolean,
): string[] {
  const sorted = [...stops].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (sorted.length <= 1) return sorted.map((stop) => stop.id);
  if (sorted.length <= exhaustiveLimit) {
    let best = sorted;
    let bestLength = Number.POSITIVE_INFINITY;
    const order: GeoPoint[] = [];
    const used = new Uint8Array(sorted.length);
    const visit = (length: number) => {
      if (order.length === sorted.length) {
        const total = length + (end ? distance(order.at(-1)!, end) : 0);
        if (total + 1e-6 < bestLength) {
          best = [...order];
          bestLength = total;
        }
        return;
      }
      for (let index = 0; index < sorted.length; index += 1) {
        if (used[index]) continue;
        const next = sorted[index]!;
        const previous = order.at(-1) ?? start;
        const nextLength = length + (previous ? distance(previous, next) : 0);
        if (nextLength > bestLength) continue;
        used[index] = 1;
        order.push(next);
        visit(nextLength);
        order.pop();
        used[index] = 0;
      }
    };
    visit(0);
    return best.map((stop) => stop.id);
  }
  // Larger days: nearest neighbour from the start (or the first stop), then 2-opt.
  const remaining = [...sorted];
  const order: GeoPoint[] = [];
  let current: GeoPoint = start ?? remaining.shift()!;
  if (!start) order.push(current);
  while (remaining.length > 0) {
    let nearest = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      if (distance(current, remaining[index]!) < distance(current, remaining[nearest]!)) nearest = index;
    }
    current = remaining.splice(nearest, 1)[0]!;
    order.push(current);
  }
  return improveByTwoOpt(order, start, end, distance, directed).map((stop) => stop.id);
}
