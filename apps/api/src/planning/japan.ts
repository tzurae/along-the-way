/**
 * Whether a point is in Japan, closely enough to pick a transit provider: Japan's bounding box
 * without the parts of China, Korea and Russia that fall inside it.
 */
export function inJapan(point: { latitude: number | null; longitude: number | null }) {
  const { latitude, longitude } = point;
  if (latitude === null || longitude === null) return false;
  if (latitude < 24 || latitude > 46 || longitude < 122 || longitude > 154) return false;
  if (longitude < 124 && latitude > 26) return false; // China's coast (Shandong)
  if (longitude < 128.5 && latitude > 32.5) return false; // Korea's west and south coasts, Jeju
  if (longitude < 129.6 && latitude > 34.75) return false; // Korea's east coast: Busan, Ulsan, Pohang
  if (longitude < 132 && latitude > 37) return false; // Ulleungdo, North Korea
  if (longitude < 139.3 && latitude > 38.7) return false; // North Korea's and Russia's coasts
  return true;
}
