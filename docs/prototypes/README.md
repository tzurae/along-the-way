# Clickable prototypes and decisions (as of 2026-10-11)

Static HTML prototypes the product owner reviewed. They are the visual and interaction authority for the next
implementation round; the real app does not match them yet. Open any file directly in a browser; links between
pages work. Photos in `photo-assets/` are not included (the real photos live in `apps/api/assets/place-photos/`);
rows without a photo show the same 「尚無可用照片」 placeholder the app uses.

| File | Page |
|---|---|
| `index-v2.html` | 地點 → AI 建議 |
| `pocket-v2.html` | 地點 → 口袋名單 |
| `plan.html` | 行程 |
| `route.html` | 行程 → 幫我排順路 |
| `today.html` | 今天 |

## Decisions the prototypes encode

- **One verb for putting a place into the itinerary: 「排入行程」.** Same on 口袋名單 and AI 建議: page-head primary
  button 「排入行程」 → selection mode (checkboxes, 「已選 N 個」, fixed bottom bar) → 「選擇日期」 → one schedule sheet
  with 4-column date + weekday chips → confirm 「將 N 個地點排入 10/23（週五）」 → toast with 「查看行程」.
- **AI 建議 places go straight into the itinerary** (decision by the product owner, 2026-10-11). The earlier
  two-stage model (AI 建議 → 口袋名單 → 行程) was rejected for this page; 口袋名單 stays the shared candidate list
  for places added with 「加入地點」.
- **Both pages share one row anatomy:** thumbnail (82px phone / 96×88 desktop) · name + type chip (8px gap) ·
  two-line description · one meta line · votes. No per-row chevron, no per-row schedule button.
- **Scheduled rows are visibly different:** persistent 10% tint and a filled 「已排入 10/23（週五）」 pill. A 1.4 s
  highlight alone was rejected as invisible.
- **Missing location blocks scheduling:** row shows 「缺少位置」 and a 「補上位置」 action; disabled in selection mode.
- **Page-head buttons are identical on both pages:** 44px high, 15px primary / 14px secondary, 7px icon gap.
- Places only show photos that have a reviewed curated binding; never borrow another place's photo.

## Not implemented in the real app yet

- The flow above. The real 口袋名單 currently has a per-row 「排入行程」 button (commit following this file) and
  AI 建議 still uses 「選擇」 + 「加入口袋名單」.
- Backend: one idempotent endpoint that accepts an AI proposal and assigns a day in one transaction (today:
  accept, then a separate day-assignment request); creator-only authorization for AI places is UI-only today;
  per-member 倒讚; who-added-a-place; distance to lodging; applying a searched place's location to an existing place.
- AI 建議 photos: proposals use Google place ids with no matching place identity, so curated photos cannot bind.
- Remove the per-row `>` chevron in the real 口袋名單 and align the two pages' button/sheet sizes with the prototypes.

## Known process lesson

The two prototype pages carry separate stylesheets, which caused repeated size mismatches. The real app should use
one shared component for the schedule sheet, day picker, row, and page-head buttons.
