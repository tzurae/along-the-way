export interface GeoPoint {
  id: string;
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
// Exhaustive search is exact and fast up to 8 stops (8! = 40,320 orders).
const EXHAUSTIVE_LIMIT = 8;

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
export function routeLength(order: GeoPoint[], start: GeoPoint | null, end: GeoPoint | null) {
  if (order.length === 0) return 0;
  let total = start ? straightLineMeters(start, order[0]!) : 0;
  for (let index = 1; index < order.length; index += 1) total += straightLineMeters(order[index - 1]!, order[index]!);
  return total + (end ? straightLineMeters(order.at(-1)!, end) : 0);
}

function* permutations(items: GeoPoint[]): Generator<GeoPoint[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index]!, ...tail];
  }
}

function improveByTwoOpt(order: GeoPoint[], start: GeoPoint | null, end: GeoPoint | null) {
  let best = order;
  let bestLength = routeLength(best, start, end);
  let improved = true;
  while (improved) {
    improved = false;
    for (let from = 0; from < best.length - 1; from += 1) {
      for (let to = from + 1; to < best.length; to += 1) {
        const candidate = [...best.slice(0, from), ...best.slice(from, to + 1).reverse(), ...best.slice(to + 1)];
        const length = routeLength(candidate, start, end);
        if (length + 1e-6 < bestLength) {
          best = candidate;
          bestLength = length;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Orders stops so the route from `start` through every stop to `end` is shortest in straight
 * lines, exactly up to EXHAUSTIVE_LIMIT stops and by nearest neighbour plus 2-opt beyond it.
 * Ties keep the earliest order by stop id, so equal inputs give equal output.
 */
export function orderByStraightLine(stops: GeoPoint[], start: GeoPoint | null, end: GeoPoint | null): string[] {
  const sorted = [...stops].sort((left, right) => left.id.localeCompare(right.id));
  if (sorted.length <= 1) return sorted.map((stop) => stop.id);
  if (sorted.length <= EXHAUSTIVE_LIMIT) {
    let best = sorted;
    let bestLength = Number.POSITIVE_INFINITY;
    for (const order of permutations(sorted)) {
      const length = routeLength(order, start, end);
      if (length + 1e-6 < bestLength) {
        best = order;
        bestLength = length;
      }
    }
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
      if (straightLineMeters(current, remaining[index]!) < straightLineMeters(current, remaining[nearest]!)) nearest = index;
    }
    current = remaining.splice(nearest, 1)[0]!;
    order.push(current);
  }
  return improveByTwoOpt(order, start, end).map((stop) => stop.id);
}
