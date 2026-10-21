export const dayPlan = {
  title: (label: string, date: string) => `排${label}・${date}`,
  draftNotice: "比較目前順序與順路建議；只有按下儲存才會改動行程。",
  couldNotPlan: "無法排列這一天",
  couldNotSaveOrder: "無法儲存這個順序",
  planning: "正在排列地點…",
  saving: "儲存中…",
  mapLegendLabel: "地圖路線圖例",
  genericTransit: "大眾運輸",
  walking: "步行",
  routeProvider: (provider: string) => `路線由 ${provider} 提供。`,
};
