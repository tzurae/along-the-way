---
version: 1
slug: "apps-web-src-app-tsx"
primary_target: "apps/web/src/App.tsx"
related_targets: ["apps/web/src/TripPlaceWorkspace.tsx","apps/web/src/DiscoveryWorkspace.tsx","apps/web/src/TodayWorkspace.tsx","apps/web/src/PlaceDetailContent.tsx","apps/web/src/PlaceThumbnail.tsx"]
---

# Trip workspace (app shell, 地點)

Scope: the signed-in trip workspace shell and the 地點 tab (wishlist + AI candidates). Mode: Operate. Audience: three family members planning on a 390px phone first, desktop second (PRODUCT.md). Visual world: incumbent and unchanged (palette, type, buttons); this brief governs structure only. Issue #87, stacked on PR #86.

## Direction contract

THESIS: A trip is a phone app with four places to go, not a seven-tab document. The workspace refuses the stacked trip list plus wrapped tab wall and the in-row expansions that turned lists into long pages.

OWN-WORLD: Incumbent cream ground, ink text, terracotta accent and display serif headings, used sparingly; standard bottom tab bar, segmented control, table rows and a bottom sheet/side panel, all in the existing button and border language.

STORY: A family member opens the trip and immediately sees today, the plan, the places, or the people; they scan places in one list, open one to read why and decide, and every irreversible action asks first.

FIRST VIEWPORT: Phone: a one-line header 「{trip} ▾」, the selected tab's content starting directly under it, a fixed bottom bar 今天・行程・地點・成員. 地點 shows a segmented 想去｜AI 建議 above the table; tapping a row slides its detail up from the bottom. Desktop: a left rail with the trip switcher and the four destinations; tables with a right detail panel.

FORM: 「底部分頁＋點開看詳情」, position 3 on the ordered list of seven structures, seed key 586f025c.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Approved place-detail extension (2026-10-09)

This is an extension of the same Operate direction, not a new design selection. The selected B prototype behavior is translated into the incumbent visual world: small reserved thumbnails in existing rows; the existing mobile bottom sheet and desktop side panel; native horizontal photo swiping; restrained terracotta/ink controls; and sourced, scan-friendly content below a stable image area.

The compact attribution strip remains exactly 56px in the panel's main scroll flow. Full work, author, source, license, modification, location and check metadata belongs in a nested full-image dialog with complete-composition image fit. Empty, failed, unknown, conflicting and out-of-date states remain readable and explicit; they do not borrow another place's content or replace recommendation, notes, votes, schedule, navigation or member actions.
