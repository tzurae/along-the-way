export const dayPlan = {
  title: (label: string, date: string) => `排${label}・${date}`,
  draftNotice: "這是草稿，不會變更行程；只有這一天的起訖時間，以及你選擇套用的順序會被儲存。",
  start: "開始",
  end: "結束",
  rePlan: "重新排",
  couldNotPlan: "無法排這一天",
  endMustBeAfterStart: "結束時間必須晚於開始時間。",
  couldNotSaveHours: "無法儲存這一天的時間",
  orderSaved: "已儲存這一天的順序。",
  couldNotSaveOrder: "無法儲存這個順序",
  planning: "正在排這一天…",
  loadSummary: (busy: string, window: string) => `已排 ${busy}，共 ${window}`,
  suggestedOrderDescription: "建議順序：由距離最近的地點開始。",
  currentOrderDescription: "這一天目前的順序。",
  draftTimetable: "每日行程草稿",
  nothingFits: "目前沒有任何地點適合排進這一天。",
  notInDraft: "這些地點這天排不進去",
  // Why the day has no room, from the scheduler's capacity facts.
  afterArrival: (title: string, end: string, buffer: number) =>
    buffer > 0
      ? `要等「${title}」${end} 抵達、再加上預留的 ${buffer} 分鐘後才能開始排；在那之前人還不在這裡。`
      : `要等「${title}」${end} 抵達後才能開始排；在那之前人還不在這裡。`,
  // `start` is the flight/train's own time; `cutoff` is the end of the last free gap, after
  // travel, check-in and luggage are reserved (null when no gap is left at all).
  beforeDeparture: (title: string, start: string, cutoff: string | null) => cutoff
    ? `「${title}」${start} 出發，要先預留前往、報到和取行李的時間，所以 ${cutoff} 之後不能再排地點。`
    : `「${title}」${start} 出發，扣掉前往、報到和取行李的時間後，這天已經不能再排地點。`,
  noGap: (start: string, end: string) => `扣掉這些後，這天 ${start}–${end} 沒有任何空檔。`,
  longestGap: (start: string, end: string, length: string) => `扣掉固定行程後，最長的空檔是 ${start}–${end}（${length}），放不下這些地點的停留和交通。`,
  unscheduledNextStep: "地點沒有被刪除，仍在這一天。可以改排到其他天，或用「調整時間」延後這天的結束時間。",
  routeTimes: (attributions: string) => `路線時間：${attributions}。`,
  openingHoursAttribution: "營業時間：Google Maps。",
  backToCurrentOrder: "回到目前順序",
  saving: "儲存中…",
  useThisOrder: "使用這個順序",
  trySuggestedOrder: "試試建議順序",
};
