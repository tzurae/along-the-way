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

function pathLength(order: GeoPoint[], anchor: GeoPoint | null) {
  let total = 0;
  for (let index = 1; index < order.length; index += 1) total += straightLineMeters(order[index - 1]!, order[index]!);
  if (anchor && order.length > 0) {
    total += straightLineMeters(anchor, order[0]!) + straightLineMeters(order.at(-1)!, anchor);
  }
  return total;
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

function improveByTwoOpt(order: GeoPoint[], anchor: GeoPoint | null) {
  let best = order;
  let bestLength = pathLength(best, anchor);
  let improved = true;
  while (improved) {
    improved = false;
    for (let start = 0; start < best.length - 1; start += 1) {
      for (let end = start + 1; end < best.length; end += 1) {
        const candidate = [...best.slice(0, start), ...best.slice(start, end + 1).reverse(), ...best.slice(end + 1)];
        const length = pathLength(candidate, anchor);
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
 * Orders stops by straight-line distance. With an anchor (the night's lodging)
 * the route leaves from and returns to it; otherwise it is an open path.
 * Ties keep the earliest order by stop id, so equal inputs give equal output.
 */
export function orderByStraightLine(stops: GeoPoint[], anchor: GeoPoint | null): string[] {
  const sorted = [...stops].sort((left, right) => left.id.localeCompare(right.id));
  if (sorted.length <= 1) return sorted.map((stop) => stop.id);
  if (sorted.length <= EXHAUSTIVE_LIMIT) {
    let best = sorted;
    let bestLength = Number.POSITIVE_INFINITY;
    for (const order of permutations(sorted)) {
      const length = pathLength(order, anchor);
      if (length + 1e-6 < bestLength) {
        best = order;
        bestLength = length;
      }
    }
    return best.map((stop) => stop.id);
  }
  // Larger days: nearest neighbour from the anchor (or first stop), then 2-opt.
  const remaining = [...sorted];
  const order: GeoPoint[] = [];
  let current: GeoPoint = anchor ?? remaining.shift()!;
  if (!anchor) order.push(current);
  while (remaining.length > 0) {
    let nearest = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      if (straightLineMeters(current, remaining[index]!) < straightLineMeters(current, remaining[nearest]!)) nearest = index;
    }
    current = remaining.splice(nearest, 1)[0]!;
    order.push(current);
  }
  return improveByTwoOpt(order, anchor).map((stop) => stop.id);
}
