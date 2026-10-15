/** One label per normalized place type, shared by every list, detail, dialog and filter. */
export const placeTypeLabels = {
  activity: "景點",
  worship: "寺社",
  museum: "博物館・展覽",
  nature: "自然・公園",
  restaurant: "餐廳",
  cafe: "咖啡・甜點",
  shopping: "購物・市場",
  lodging: "住宿",
  station: "車站",
  airport: "機場",
  other: "其他",
};

/** Filters group lodging, station and airport: they are rarely what a family searches for. */
export const placeTypeFilterLabel = (type: keyof typeof placeTypeLabels) =>
  type === "lodging" || type === "station" || type === "airport" ? "住宿・交通" : placeTypeLabels[type];
