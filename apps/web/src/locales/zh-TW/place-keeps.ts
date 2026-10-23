export const placeKeeps = {
  toggle: "下次還要來",
  toggleHelp: "記下來，跟你一起出遊過的家人都看得到。",
  noteLabel: "為什麼（選填）",
  notePlaceholder: "例如：抹茶霜淇淋很好吃",
  saveNote: "儲存",
  savingNote: "儲存中…",
  noteSaved: "已記下原因",
  loading: "讀取中…",
  loadFailed: "暫時讀不到「下次還要來」，請稍後再試。",
  saveFailed: "沒有存到，請再試一次。",
  sectionTitle: "家人說下次還要來",
  listLabel: "家人說下次還要來的地點",
  me: "我",
  someone: "家人",
  byline: (who: string, trip: string | null) => trip ? `${who}・${trip}` : who,
  tripLabel: (name: string, startDate: string) => {
    const [year, month, day] = startDate.split("-").map(Number);
    return `${name}（${year}/${month}/${day}）`;
  },
  addToPocket: "加入口袋名單",
  adding: "加入中…",
  alreadyHere: "已在這趟",
  added: (name: string) => `已把「${name}」加入口袋名單`,
  showAll: (count: number) => `看全部 ${count} 個`,
  showLess: "收起",
};
