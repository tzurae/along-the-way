# Along the Way

Along the Way helps people shape a trip together: what matters now, what still
needs a decision, and how to keep the plan comfortable in real life.

This repository currently contains two deliberately separate surfaces:

- The original static Hong Kong itinerary at the repository root. GitHub Pages
  can keep serving it without a build step.
- The new full-stack foundation under `apps/`, backed by PostgreSQL/PostGIS and
  exposed through Caddy.

## Run the full stack

```sh
cp .env.example .env
# Replace both database passwords, set TOKEN_SECRET, and set BOOTSTRAP_OWNER_EMAIL.
docker compose --profile local up --detach --build --wait
```

Open `http://localhost`, request a sign-in link for the configured Owner, then
open the captured message at `http://localhost:8025`. A PostgreSQL-backed worker
delivers queued authentication and invitation email. The same magic-link,
session, Trip, membership, and invitation path is used outside local
development; Mailpit exists only in the local Compose profile, while staging
uses authenticated Gmail SMTP.
Authentication requests are deliberately bounded: `/api/auth/*` accepts at most
8 KiB, other `/api/*` requests accept at most 2 MiB, and magic-link consumption
allows 30 attempts per client IP in 10 minutes. A successful authenticated
request renews the 30-day browser cookie. PostgreSQL persists that sliding
renewal at most once per day and keeps one extra day of server-side expiry slack,
so write throttling never shortens the 30-day idle lifetime. Every session also
expires absolutely 90 days after creation. `POST /api/logout-everywhere` revokes
all sessions for the signed-in account and clears this browser's cookie.
`POST /api/logout` also accepts an optional `{userId}` target for immediate or
deferred sign-out. A matching session (or no valid session) returns 204 and clears
the cookie. If the cookie now belongs to a different account, it returns
`409 logout_target_mismatch` without revocation or any cookie change.

HTTPS sessions use `__Host-along_the_way_session` with Secure, HttpOnly,
SameSite=Lax and Path=/, without Domain. Local HTTP uses `along_the_way_session`;
the old unprefixed cookie is not accepted on HTTPS, so existing users sign in again.
Startup rejects non-HTTPS `SITE_ADDRESS` values except HTTP on `localhost`,
`127.0.0.1` or `::1`; the local Compose address `http://localhost` remains allowed.
Both magic-link request routes always set a 7-day HttpOnly login-nonce cookie
(`__Host-along_the_way_login_nonce` on HTTPS), including unknown recipients.
Only its SHA-256 hash is stored with the link. A matching browser signs in directly;
a foreign browser or a switch from a different signed-in account receives
`409 confirmation_required` with `targetEmail` and nullable `currentEmail` (both
masked). The link remains unused until the user explicitly resubmits
`{token, confirm: true}`. Successful sign-in revokes the replaced browser session.

The email also contains a 6-digit one-time code. `POST /api/auth/magic-links/verify-code`
accepts `{email, code}` only with the matching login-nonce cookie. Link and code
share a 7-day expiry and one successful use; five wrong codes revoke both.
Code attempts are limited to 10 per normalized address and 30 per IP per 15 minutes.
The sign-in screen supports code entry and an explicit account-switch confirmation.
Email addresses are NFKC-normalized, trimmed and lowercased, and only one plain
`local@domain` address is accepted (no display names, quoting or recipient lists).

Invites create `invited`, not active, users. Ordinary login sends them no mail;
accepting a still-valid invite-linked magic link activates the account. Existing
active accounts remain active. A global 300-email UTC-day budget covers both magic
links and invitations before enqueueing: exhaustion silently preserves the generic
202 login response, but invitation creation returns 429. Invitation and trip-creation
limits are respectively 10 and 5 attempts per account per UTC day. Invite email
labels are plain text, stripped of URL-like content and controls, and capped at
60 characters; the subject contains no user-supplied name.

Operators can disable an account using its normalized email address:

```sql
update users set status = 'disabled' where email = 'person@example.com';
```

Disabled accounts fail authentication on every subsequent HTTP request. Existing
SSE streams close at their next authorization check, before another private payload
or heartbeat. Already-issued magic links/codes cannot sign them in, and neither
ordinary nor invite-linked login requests enqueue mail. New invitations to disabled
recipients are refused. Queued mail checks recipient status before delivery and skips
disabled recipients. Disabling does not delete trips, memberships or account history.

The email worker separately reserves a global 300-attempt UTC-day delivery budget
immediately before each SMTP send, across magic links, invitations and retries.
This prevents an outage backlog from bypassing the daily ceiling after recovery.
Valid jobs refused by that ceiling remain queued until the next UTC midnight;
the refusal neither increments their SMTP attempt count nor marks them failed.
Expired/revoked magic links and invitations are still skipped rather than sent.

Unknown and transient SMTP failures retry with 30-second, 2-minute, 10-minute,
1-hour, 6-hour, and 24-hour backoff steps. SMTP 4xx and quota responses such as
`550 5.4.5` / “daily sending quota exceeded” are retryable, not immediate permanent
failures. Permanent recipient errors such as `5.1.x` fail immediately; other
definitive non-quota 5xx rejections retain the same terminal behavior. A transient
job becomes terminal only after exhausting the retry schedule. Terminal jobs retain
`failed_at` for operations. A failed pending invitation remains pending: the Owner
recovers by revoking it and sending a new invitation.

Migration `029_auth_hardening` deliberately retains the expanded `users.status`
constraint and invited/disabled users on downgrade, while removing its magic-link
columns and index. It does not delete or activate those accounts. Original pending
invitation links for invited users remain usable after upgrading again.

Residual access policy: an invitee who accepts becomes an active account and can
create trips and invite a second generation of addresses, including mailbox aliases.
Those accounts have their own 10-invitation/day and 5-trip/day account limits;
the two global 300/day email ceilings bound mail, not the number of approved people.
Aliases remain distinct normalized addresses. There is no operator-approval gate
for subsequent invitations or per-recipient daily invitation limit in this policy.
Preventing that expansion requires an explicit product rule; these quotas do not
claim to eliminate it.

The same worker runs database retention at most once per hour. Idempotent mutation
responses can be replayed for 7 days; older `mutation_requests` rows are deleted,
and rate-limit counters are deleted as soon as their own window has elapsed.
Migration `031_usage_limits` indexes the replay timestamp. List-returning trip-place
mutations and discovery workspace mutations store only a readback marker: a retry
does not repeat the write, but returns the authorized current read model rather than
preserving a potentially multi-megabyte historical snapshot. Older full snapshots
remain replayable until retention removes them.
Within that seven-day window, stored historical mutation responses can still include
emails that were visible when the response was created, even if current membership
or roster permissions no longer expose those emails. This residual applies to stored
snapshots, not the current authorized projections returned by readback markers.

Application rollback to v0.10.0 cannot interpret the new compact readback markers.
Retries of mutations whose stored result is such a marker fail on that older binary
rather than replaying successfully. This is an accepted rollback limitation, not a
claim of replay compatibility with v0.10.0.


Useful checks:

```sh
curl http://localhost/health
curl http://localhost/ready
curl http://localhost/api/trips # returns unauthenticated until signed in
```

Development verification:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Staging setup, HTTPS security headers, isolated and resource-limited containers,
three-release secret retention, nightly database backups and tested restore
commands, persistent data, and rollback are documented in
[`docs/operations/staging.md`](docs/operations/staging.md).

## Place details and photos

Pocket-list, discovery and Today previews return only curated or Commons photos;
they never request Google photo metadata or media. Detail pages show the first available of:

1. **Google Places photos**: provider-backed places request up to two photos for the
   detail gallery because Google's terms forbid storing them. Signed, user-bound
   photo resource URLs let the image route fetch media directly without a second
   GetPlace call. Detail responses use `Vary: Cookie`.
2. **Curated photos**: when Google returns no photos, fails or is rate-limited, use
   packaged, individually reviewed Wikimedia Commons works with per-work attribution,
   licence/version, verification revision and derivative notices.
3. **Commons representative photo** (#121): when the Google and curated sources above
   yield no photo, use the stored representative photo. When a Google place is added,
   its Google Maps CID (from `googleMapsUri`) is looked up once on Wikidata (`P3749`).
   Only when exactly one item matches, that item has a representative image (`P18`),
   and the work is CC0, CC BY or CC BY-SA, the API downloads Commons' 1280px and
   330px renditions into PostgreSQL (`place_photo_blobs`, `commons_place_photos`).
   Reads never contact Wikimedia; misses and Wikimedia failures do not store the CID.

Name and coordinate searches also produce Commons candidates (see below). Every
place without a Commons photo automatically takes the nearest name-related
licensed P18 work, or otherwise the nearest licensed P18 work within 1 km.
A list row without a photo shows its place-type icon. `photosUnavailable` is true
only when the Google lookup failed and neither curated nor Commons fallback exists;
showing either fallback keeps it false. A failed or rate-limited Google lookup still
makes the detail response `private, no-store`, so a temporary failure is not cached.
Gallery loading uses a shimmer and thumbnail blur-up; initial lists use `PlaceListSkeleton`.

### Lists and must-items (#123)

Both 口袋名單 and AI 建議 use one compact row (`PlaceListRow`). Each row shows a
64px thumbnail (a button that opens the detail), the name with a type chip, one
list-specific line, and a status. A wishlist place without a 想去 reason shows
the area part of its address instead. List rows never show Google photos, so they
need no Google photo attribution. The detail gallery retains per-work Commons
credits and Google attribution where applicable.
Both lists are ordered by confirmed vote count and slide rows to their new
position when the order changes (`FlipList`; a fade under reduced motion).
AI 建議 hides rejected proposals. AI suggestions only go into the itinerary: there
is no accept-to-wishlist endpoint, an accepted proposal never appears in 口袋名單,
and its row reads 「已選進行程・待排日期」 until it has a day (「已排入行程」).
Detail sheets only display information; voting, scheduling and removal live on
the row and its 「⋯」 menu (`RowMenu`).

Both lists share search (name or area) and filter chips (`PlaceFilters`):
我按過讚, 狀態, 類型 and 地區. Chips within a group combine with OR, groups with
AND, and only values that occur are offered. Filters are not kept in the URL;
their localStorage keys include both account and trip and are removed on sign-out
or account switch. Japanese addresses use the ward after a city, then the
municipality; Romanized `Ward`, `-ku`, `City`, `Town` and `District` components
drop that suffix so variants group together. Postal, country and street text never
become area chips.

### Place categories (migration 027)

Every place uses one category set (`PLACE_TYPES` in
`packages/contracts/src/trip-skeleton.ts`): `activity` 景點, `worship` 寺社,
`museum` 博物館・展覽, `nature` 自然・公園, `restaurant` 餐廳, `cafe` 咖啡・甜點,
`shopping` 購物・市場, `lodging`, `station`, `airport` and `other`. The type chip
groups lodging/station/airport as 住宿・交通. Google places get their category
from Google's `primaryType` (`mappedPlaceType`); AI proposals use the same
mapping. Migration `027_normalized_place_types` only widens the CHECK
constraints. Existing rows keep their category until
`bun apps/api/src/database/reclassify-place-types.ts` (dry run; `--apply` writes)
re-reads each Google place's `primaryType` once (Place Details, `primaryType`
field only) and updates `place_identities`, provider-backed `trip_places`/`places`
and `candidate_proposals`. Places Google returns without a type are skipped.
A pre-0.9.0 build rejects the new categories when it reads them.

### Per-stop nearby alternatives (migration 044)

On 行程, 「選備案」 is available to schedulers for untimed day places with coordinates,
except lodging/station/airport/other. Nearby Search requests a 1000 m circle, POPULARITY,
up to 20 results and zh-TW (the trip's single-country region when available). The server
keeps the same mapped place type, excludes the original and already assigned/scheduled
trip places, sorts by Google rating then review count (null ratings last), and returns eight.
The [Google Table A types](https://developers.google.com/maps/documentation/places/web-service/place-types#table-a)
are an explicit whitelist, not an inverse of every category-mapping rule.
Distance is rounded straight-line metres. Ratings and review counts are live only:
never database fields, mutation replay payloads or Today snapshots.

- `POST /api/trips/:tripId/days/:dayId/trip-places/:tripPlaceId/nearby-alternatives`
  returns candidates plus `dayVersion`; uses the existing Google budget and photo proxy.
- `POST /api/trips/:tripId/days/:dayId/trip-places/:tripPlaceId/replacement`
  takes `{ expectedDayVersion, providerPlaceId }` and an `Idempotency-Key`.
- `POST /api/trips/:tripId/stop-replacements/:replacementId/undo`
  takes `{}` and an `Idempotency-Key`.

Replace/undo atomically write desired days (migration 007 derives assignments), preserve
the stop's slot, and return the displaced place to Pocket, not 待安排. A chain retains the
root original; 「改回」 restores that root into the current replacement's slot. An active
`replacedStop` is projected only while its replacement remains on the relation's day;
moving, scheduling or archiving it prevents undo. Mutations return the current trip-place
list, record collaboration events and replay by readback marker. Stale versions or occupied
candidates return 409; Google quota/unavailability return 503 without replacing the stop.
Offline members and members without scheduling permission see no replacement actions.

### Per-stop nearby activities (migration 046)

On 行程, every located day stop gets a quiet 「附近活動」 pill beside 備案. It is view only
(nothing is added to the trip), so any active member may use it; it is hidden offline. It shows
what is on near that stop on the day's local date — dated events (夜間參拜、祭典、市集) and
ongoing popular experiences (和服租借、季節點燈) — each with its source page.

- `POST /api/trips/:tripId/days/:dayId/trip-places/:tripPlaceId/nearby-activities` (no body)
  returns `{ stopTripPlaceId, date, fetchedAt, activities[] }` (`NearbyActivitiesResponse`).
  Non-members get 404; a stop not on that day 409, a stop without coordinates 422
  `activities_unsupported`; without `OPENAI_API_KEY`/`OPENAI_MODEL` 503 `activities_unavailable`;
  a failed provider call 503 `provider_unavailable` (not cached).
- Provider: one OpenAI Responses call with `web_search` (`search_context_size: "low"`, approximate
  user location from the stop's country and time zone, at most 4 searches, 30 s timeout) and a
  strict JSON schema; at most 6 items within about 1.5 km. Names are zh-TW (the original in
  parentheses only when it differs; a self-repeating 「名稱（名稱）」 is collapsed).
- Sources rule (same as 幫我找): an item is kept only when its `sourceUrl` is a page that web
  search returned in that same response. An item without a stated time (no `startsAt` and no
  `timeText`) is dropped, because it is not actionable on the road. The server adds rounded
  straight-line metres when the venue's coordinates are known.
- Cache: the last successful answer per stop and local date (`nearby_activity_results`) is reused
  with no provider call while the stop's local day equals the day it was fetched (stop time zone,
  then the matching country stop, else UTC); it keeps its original `fetchedAt`. The retention
  worker deletes rows older than 2 days.
- Cost guard: only uncached lookups count, under rate-limit action `nearby_activities`
  (30 per account and 60 per IP per hour); over the limit returns 429 `rate_limited`.
- Logs carry counts only (`nearby_activities_model_call`), never the key, prompt or provider body.


### Commons photo backfill (#149)

Run `DATABASE_URL=... bun apps/api/src/database/backfill-commons-photos.ts`
after deploying migrations `024`, `032_commons_photo_candidates` and
`033_commons_candidate_names`. It checks only identities without a
`commons_place_photos` row, extracts the CID from stored `places.source_url`,
`legacy_place_origins.source_url` or `trip_place_contributions.source_url`, and
queries Wikidata and Wikimedia Commons serially. It never calls Google and is
safe to rerun. Each lookup logs its outcome, and the final line prints counts
for matches and every miss reason.

### Commons candidate backfill and photo feedback (migrations 032–035)

Deploy `032_commons_photo_candidates`, `033_commons_candidate_names`,
`034_feedback`, then `035_photo_feedback`. Run
`DATABASE_URL=... bun apps/api/src/database/backfill-commons-candidates.ts`.
It serially searches Wikidata labels and aliases in Japanese, Chinese and
English plus a 1 km coordinate search, then keeps at most three works that pass
the existing P18, Commons licence and rendition checks. It automatically applies
the nearest name-related work; if none qualifies, it applies the nearest work
within 1 km. The chosen row is `confirmed` with `auto_applied=true`, and pending
siblings become rejected without a user decision.

Generation skips every Wikidata QID already rejected for that place and never
deletes an unrelated stored candidate. It never calls Google, waits between
identities, and prints per-identity outcomes plus final counts. `--refresh`
rechecks existing pending candidates and applies the same selection rule without
overwriting a confirmed photo or reapplying an admin-removed QID.

Any trip member can submit `POST /api/trips/:tripId/trip-places/:tripPlaceId/photo-feedback`
with a required reason and optional note. Admin feedback includes the place,
reason and reported Wikidata QID. `POST /api/admin/feedback/:id/remove-photo`
removes the reported photo under the same identity-first lock, rejects a Commons
candidate so generation cannot re-add it, and marks the report done. The old
candidate review, decision, candidate asset and member report routes were removed.

These migrations are expand-only; older application code ignores the new table.
Rollback requires retaining these migration files in the rollback build because
Kysely rejects a migration history containing files missing from that build.

### Today place guides (migration 036)

Deploy `036_place_guides` before enabling the Today guide API. The first member
read claims one background generation per place identity and waits for up to
eight seconds. The claim is stored in PostgreSQL, so API processes and the
backfill cannot generate or overwrite the same place concurrently; an abandoned
claim becomes retryable after two minutes. Later reads reuse the stored zh-TW
guide. Generation is limited to 30 starts per account per hour, and a failed
generation may retry after one hour. Without `OPENAI_API_KEY` or `OPENAI_MODEL`,
the API returns the 「暫時沒有導覽」 state and does not store a failure.

`GET /api/trips/:tripId/trip-places/:tripPlaceId/guide` is the trip-place route.
Today itinerary endpoints use
`GET /api/trips/:tripId/place-guide?kind=itinerary-place&id=:placeId`; the same
query route also accepts `kind=trip-place`. Both require Trip membership.
`POST /api/admin/places/:placeId/guide/regenerate` clears the stored guide and
starts a fresh claimed generation for an administrator.

Generation first uses a confirmed QID from `commons_place_photos` or
`commons_photo_candidates` to resolve Japanese, Chinese and English Wikipedia
sitelinks. Without a QID it searches Wikipedia by the stored place name. It also
searches Wikivoyage, sends only those bounded article extracts to the configured
OpenAI model, and stores only strict source-grounded JSON. No source means a
stored `no_sources` result and no model call.

Backfill existing identities serially after the migration:

```sh
DATABASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... \
  bun apps/api/src/database/backfill-place-guides.ts
```

The command skips identities with terminal `place_guides` rows, resumes a
`generating` claim left by an interrupted process, waits between identities,
and logs each outcome plus final counts. It is safe to rerun.

### Members and scheduling permission (migration 026)

成員 has sub-pages 成員, 我的資料, 邀請 (owner only) and 權限. Each member edits
only their own nickname (`PUT /api/session/profile`, at most 40 characters).
The owner can let every editor schedule (`PUT /api/trips/:tripId/editors-can-schedule`
with `{ "enabled": boolean }`, stored in `trips.editors_can_schedule`, default
false). Scheduling, rescheduling, reordering and removing scheduled places then
accept editors; otherwise they return 403 as before. Rejecting AI proposals stays
owner-only.

The same scheduling gate covers assigning and ordering a day's wishlist places,
plus creating, moving, or deleting formal itinerary items whose endpoints use
wishlist places. Rewriting or deleting a flight or lodging also requires scheduling
permission even when all of its places are travel-only. Locked itinerary items
remain read-only and cannot be deleted until the owner unlocks them; only the
owner is shown and may use the unlock action. Item deletion is permanent; there
is no recoverable-delete flow.

Member, voter and itinerary-participant email fields are nullable. Owners receive
active members' email addresses; editors receive only their own, and former
members' addresses are never returned. History and conflict actor emails follow
the same active-member rule and are visible only to the owner or that actor.
Other actors are identified by display name or a generic active/former-member
label. Child-resource idempotency scopes include the route trip, so retries
cannot cross trip boundaries. Migration 030 copies retained pre-deploy replay
rows to their trip-scoped keys and keeps the legacy rows so a production
rollback can still replay them. A must-item removal or merge whose child was
already hard-deleted cannot be mapped safely; its legacy row remains, and a
post-deploy retry returns 404 because the child is already gone.

Wishlist details list members' 必買／必吃／必喝 items:

- Table `trip_place_must_items`, added by expand-only migration 025.
- Routes `GET|POST /api/trips/:tripId/trip-places/:tripPlaceId/must-items` and
  `PATCH|DELETE …/must-items/:itemId`.
- Owners and editors can write; every write is idempotent and version-checked.
- At most 24 items per place, labels up to 80 characters, and normalized
  duplicates are rejected.
- Each write locks the parent place row and emits a collaboration event.
- Removing a place deletes its items; merging moves them into the target place
  and removes duplicates.
- AI proposal details show these items read-only once the proposal has been
  added to the wishlist.

The detail panel no longer shows 停留時間 or 預算. Existing saved values remain
in the wishlist data model, but day ordering does not use them.

Catalog publication is explicit and operator-only: run the curated manifest CLI
with reviewed bindings to existing canonical identities. Startup does not match
place names or seed real trips. Authenticated media routes enforce both trip
membership and the selected reference; a filename hash is not a public URL.

See [`docs/engineering/place-details-and-photos.md`](docs/engineering/place-details-and-photos.md)
for API/reference contracts, source applicability, asset validation, import and
failure behavior, and current isolated verification status. The acceptance source
is the [place-details/photo specification](docs/superpowers/specs/2026-10-09-place-details-and-photos-design.md).

## Day route ordering

「幫我排順路」會先產生草稿，只有按下儲存才改動行程。開啟 dialog **不呼叫任何交通供應商**。
日本日程右側先讀七天內的 NAVITIME 逐段快取，足夠時依交通時間排序，不足時先顯示直線建議；
已知非日本日程且有 server key 時使用 Google Routes，但沒有快取，所以開啟時一律先顯示直線建議。
左側「已儲存」每段只顯示距離，不查詢或畫出任何供應商的路線。
不計算營業時間等待、行程容量或行李可行性。

兩欄都畫同一套時間軸（`packages/contracts/src/day-timeline.ts` 的 `simulateDay`；route 回應的 `frame`
帶規劃窗、起點、終點、窗內固定安排和直線估分參數，舊 API 沒有 `frame` 就不畫）。左欄用已儲存順序
（套上 dialog 裡已有的交通分鐘），右欄用候選順序。時間軸從規劃窗開始（出門時間、落地 +60 分、起飛 −120 分），
依序加每段移動、每站停留、等入座和固定安排；每段移動優先用 dialog 裡已有的 NAVITIME／Google 分鐘，
沒有才用直線估計，進出固定安排的路段一律直線估計，缺座標的路段寫「無法估計」，之後不畫時刻。
三餐照「早餐 10:30 前、午餐 11:30–13:00、晚餐 17:30–19:00 入座」：10:30–15:00 之間到的第一家餐廳標
「午餐・系統判斷」，16:30–19:00 到、又是最後一站的餐廳標「晚餐・系統判斷」，晚到加「晚了約 N 分」；
沒有時插「午餐／晚餐・還沒選地方」空格。從住宿出發、10:30 前出門的日子，第一站是 10:30 前到的咖啡店或
餐廳時標「可當早餐」，否則第一列是「早餐・出門前」。頭段或中段直線估計超過 120 分是長途日：只寫一句
「這段很遠…這天先不排三餐」，後面不畫時刻；尾段超過 120 分只寫「要多久系統算不準」，終點是航班時加
「HH:MM 起飛，HH:MM 前要到機場」。最後一列是「約 HH:MM 回到住宿」，dialog 最上面寫一次「時間都是估計」。

成員可以標「哪一餐」（`trip_places.meal_role`，migration 050：`breakfast`／`lunch`／`dinner`／`none`，
null＝自動判斷；`PATCH …/planning` 的 `mealRole` 跟 `effortLevel` 一樣三態：沒送不改、null 清掉、有值設定；
`TripPlaceDto.mealRole`）。標了的站就是那一餐，不管類型和位置，標籤只寫「午餐」（沒有「系統判斷」），
停留至少 60／75 分，早到一小時內等入座；標午餐但 10:30 前到寫「午餐・太早」，標晚餐、不是最後一站、16:30 前到寫
「晚餐・太早」；標晚餐又是最後一站的店不管多早到都等到 17:30。好幾站標晚餐時，只有順序裡最後一家是晚餐，其他當一般站。
`none` 永遠不算一餐，也不標「可當早餐」「也是餐廳」。長途日有標的站在名字旁寫那一餐，不寫時刻。
右欄可編輯的列有一顆「哪一餐？」按鈕（顯示目前狀態），按下原地展開「早餐｜午餐｜晚餐｜不算一餐｜改回自動判斷」，
選了馬上用同一支 planning API 寫入，列上寫「已存，全家都會看到」，之後只重抓 `current` 和 cached `suggested`，
拖過的順序不動。午餐已經有了、沒標的餐廳那列寫「也是餐廳」加［當晚餐］［移到備案］：「當晚餐」等於選晚餐；
「移到備案」先把它拿出候選順序、底下寫「儲存後會放進備案」，按儲存才寫入：先 `PUT …/arrangement`，再重讀
skeleton 取這天的備案清單和版本，`PUT …/days/:dayId/alternatives` 送 `[...原清單去掉它, 它]`。
server 在 `updateDayAlternatives` 同一個交易裡，把清單裡沒排進任何一天、也沒有固定安排、還是「已選」的地點改回
口袋名單（`selected_for_itinerary = false`），所以「全部排行程」不會再讀到它；之後任何一次存這天的備案都一樣。
地點詳情的編輯表單多一組「這裡算哪一餐」單選加「改用自動判斷」，摘要寫「哪一餐：午餐・你填的」或「自動判斷」。
建議順序仍照順路排，三餐不影響排序；候選欄底下比較移動分鐘和午餐、晚餐的時間或店家。
拖曳或移除地點後隨新的 custom 回應即時重算，不呼叫交通供應商。每站顯示「停留約 1 小時 30 分」（成員填的不加「約」），
車站與機場不顯示停留；被當成午餐／晚餐、停留低於 60／75 分的站，時間軸用下限並加「吃飯至少抓 60 分」。
可安排行程的人按停留文字可直接改（15–720 分鐘，沿用地點的
`PATCH /api/trips/:tripId/trip-places/:tripPlaceId/planning`，其他規劃欄位原樣送回），存好後只用 `custom` 重讀
route，不付費查詢；有權限時時間軸最後一列另有「調整這天時間」開啟這天的設定。
「全部排行程」草稿的每一天也用同一個 `simulateDay`（直線分鐘）算出 `timeline` 存進草稿，展開那天時顯示；
舊草稿沒有 `timeline` 就不顯示。
「安排」分頁的每日區塊不再顯示地點／體力／估計總時數負荷條與「超出這天設定」；「全部排行程」仍照原本的負荷檢查。

`POST /api/trips/:tripId/days/:dayId/route` accepts:

```json
{
  "order": "suggested",
  "transit": "cached"
}
```

`current`（已儲存）保留原順序；`custom` 只接受當天的地點 ID，省略代表預覽移除。
這兩種請求不呼叫交通供應商。地點上限為 100，缺座標的地點仍放在有座標地點之後，
前一晚住宿作為起點、當晚住宿作為終點，沒有住宿或座標時不憑空補點。
`suggested` 的 `transit` 可為 `cached` 或 `fetch`，省略時預設 `cached`，不會自動付費查詢。
NAVITIME 的 `cached` 只有在完整有向矩陣的分鐘資料都有效時回傳交通建議；否則回傳直線建議與
`transitCallsNeeded`（缺少／過期的唯一座標配對數）。Google 的 `cached` 不讀快取，
`transitCallsNeeded` 永遠是完整矩陣所需的元素數。日本右側顯示「用電車時間排（約 N 次額度）」，
Google 日程顯示「用大眾運輸時間排（約 N 次）」；只有按下才送 `transit: "fetch"` 與 `maxTransitCalls: N`。
NAVITIME 只查缺少的路段，Google 每次重新查完整矩陣。`maxTransitCalls` 必填且為非負整數，其他模式不能帶入。
伺服器重新計算所需的 calls／elements，若比按鈕上的 N 更多，**不呼叫供應商**，
回 `409`、`error.code: "transit_calls_changed"` 與 `error.transitCallsNeeded`（目前需要的次數）。
這個拒絕不會被包成一般直線 fallback；前端只重讀 cached suggestion，更新按鈕並提示
「行程剛變動，需要的額度變成約 N 次，請再按一次。」，不自動重送 fetch。
查詢中按鈕停用、顯示「查詢中…」與既有 skeleton。只有 NAVITIME 快取完整時會改顯示
「行程沒變，使用 7 天內查過的交通時間」；Google 永遠不顯示這句。`custom` 不呼叫供應商，
NAVITIME 只讀既有快取；Google 可在同一個開啟中的 dialog 套用已回傳的 matrix，缺資料仍顯示「估計」。
若先移除地點再按交通排序，仍保留移除，只調整剩下的候選順序。

設定 server-only `RAPIDAPI_KEY` 後，API 會用 `trip_country_stops.country_code = JP`
判定 NAVITIME 是否適用。日程沒有直接的 country-stop 欄位，所以使用前一晚／當晚住宿、
當天 itinerary endpoints 的 `countryStopId`；沒有當天依據時，使用最近的航班／交通端點，
最後才使用旅程的國家 stops。國家不明、跨國或已知地點時區與外國 stop 相符時保守採直線。
當天任一端點或最近端點的 `countryStopId` 為 null（在旅程國家以外）時也不適用；
不能先丟掉返國抵達端點，再拿較早的日本出發端點判斷。
日本沒有 `RAPIDAPI_KEY` 時仍採直線，不改呼叫 Google；國家不明或跨國時也採直線。

只有明確送出 `suggested`＋`transit: "fetch"`，才會向 RapidAPI
`navitime-route-totalnavi.p.rapidapi.com/route_transit` 補查起點住宿→每站、每站→其他站、
每站→終點住宿的有向交通時間。每段一律用**當地當天 09:00** 出發，這是排序近似，
不是依前一站停留時間推進的時刻表。最多 7 站採完整排列求最短總分鐘數；
超過 7 站採 nearest-neighbour + 有向 2-opt，結果不比已儲存順序更慢。
Google 也沿用這個有向分鐘排序；沒有可用交通供應商的日程保留直線演算法（最多 8 站完整搜尋）。

設有座標站數為 `n`，有座標起／終住宿各以 `s`、`e`（0 或 1）表示，
完整矩陣的 ID 配對上限是 **`n(n−1) + n·s + n·e`**；相同 ID 的自我路段為 0 分鐘、不發請求。
NAVITIME 將其依四個座標各取小數六位合併成唯一配對集合 `P`，有效分鐘快取集合為 `C`：
開 dialog 是 **0 次**；確認後的 `|P − C|` 若不大於 `maxTransitCalls`，最多查 `|P − C|` 次。
若超過已確認的上限，本次是 **0 次**並回上述 409，請使用者確認新的 N。
地圖只補相鄰的唯一座標配對 `H`，最多 **`|H − 有效 shape 快取|` 次**。
例：4 站、前後有住宿、完全沒有快取時，交通排序最多 20 次、首次地圖最多 5 次；
七天內相同行程再開 dialog 和同順序地圖均為 0 次 NAVITIME 呼叫。
`route_transit` 和 `shape_transit` 共用每 UTC 日 **60 次 global／60 次 account／60 次 IP**
guard，每次 HTTP 前都先預留額度；每個 API process 最多 4 個 NAVITIME HTTP 同時進行，
每次 timeout 8 秒、不重試。建議矩陣及 route-shapes 各有整批 20 秒 deadline：
到期停止排新工作並取消 HTTP，不等待尚未收尾的請求；建議整天回退，
shapes 保留已完成的路段、未完成的回 null。矩陣遇第一個失敗也停止排新工作，
多個錯誤同時發生時，已觀察到的 quota 錯誤優先，不被後到的 unavailable 覆蓋。
任一建議查詢失敗就整天回退原本的直線建議；guard 拒絕或 HTTP 429 回
`travelNotice: navitime_quota`，其他失敗回 `navitime_unavailable`。60 次是每日保護，
不是月額度保證；例如沒有快取的 8 站加前後住宿要 72 次，可能因 guard 回退。
已成功查到的單段結果仍各自寫入，下次只補剩餘路段，不重查已成功的部分。

回應保留原本所有 meters 欄位（都是直線公尺），新增
`travelSource: navitime | google_routes | straight_line`、`transitProvider: navitime | google_routes | null`、
每站的 `minutesFromPrevious`／`linesFromPrevious`、
`minutesToEnd`／`linesToEnd`、`totalMinutes`、`transitMatrix`（每段包含 `fromId`、`toId`、
`fromLatitude`、`fromLongitude`、`toLatitude`、`toLongitude`、`minutes`、`lines`）
和 `routeShapesAvailable`、`transitCallsNeeded`、`transitCacheDays`。`transitCacheDays: 7`
只表示 NAVITIME 這次不用供應商查詢就有完整矩陣；Google 永遠是 null。缺少路段資料時分鐘為 null、線名為空陣列，
總分鐘也為 null，不把部分時間冒充整天總計。舊回應 parser 預設直線、空 matrix、
null 分鐘、0 次待查與 null 快取天數。
回應另含 `dayStartMinute`（這天的出門時間，含當日調整，當地午夜後分鐘）、`fixedMinutes`（與每日負荷相同的固定安排分鐘）、
每站 `stayMinutes`／`stayEstimated`（成員填的為 false；AI 或類型預設為 true；車站與機場為 0／false）、
每站 `estimatedMoveMinutesFromPrevious` 與 `estimatedMoveMinutesToEnd`（與每日負荷同一公式：
`ceil(直線公尺 × 繞路係數 ÷ 速度) + 每段固定分鐘`，該段公尺為 null 時為 null）。舊回應缺這些欄位時 parser 補 null／false，
前端就不顯示回住宿時間。
候選順序使用回應 matrix；其兩端座標必須與當前 route 完全相同，不能把同 ID 的舊位置
分鐘套到新位置。NAVITIME 的 DB 快取 key 依指定規則將座標取小數六位；日程日期不同時不共用。
儲存後重讀 current 與 cached suggestion，不會自動付費產生建議；左側仍不套用 matrix。

`POST /api/trips/:tripId/days/:dayId/route-shapes` 接受
`{ "orderedTripPlaceIds": ["current-day-place-id"] }`，與 route 共用登入／成員權限、
當天歸屬和重複 ID 檢查。座標與前後住宿一律由 DB 解出，不接受客戶端座標。
NAVITIME 適用時，每個相鄰路段先讀七天內的 shape；只有缺少或過期才呼叫 `shape_transit`
並寫回（同樣 09:00、逐次 guard、最多 4 個同時執行、8 秒 timeout、整批 20 秒 deadline）。
Google 適用時不讀寫快取，直接查每個有座標的相鄰路段（詳見下段）；兩種供應商都不適用時回 `422 route_shapes_unavailable`。
回應 `{ legs: [{ fromId, toId, geojson }], travelNotice? }`；單段失敗或缺座標時 geojson 為 null，
不跨過缺座標地點畫假路線。

只有右側 candidate 的 Google Map 分頁會讀 shapes；左側只顯示起／終、編號標記與 Google Maps 提示。
同一 dialog＋順序只讀一次；拖曳不觸發，改順序後再開地圖才讀。重新開 dialog 時，
NAVITIME 先用 DB 快取；Google 再次開右側地圖會重新付費查詢。
大眾運輸畫供應商線色
（預設 `#1f3029`）的 5px 實線，步行畫 `#52645c` 虛線。失敗段不畫線，
列表顯示「這段路線無法取得」。沒有適用的交通供應商時只有起／終與編號標記，
並提示點每段 Google Maps；所有情況都不再畫連接座標的假直線。

**Owner 決定將 NAVITIME 結果存入 DB，使用七天快取。** NAVITIME 使用規約第 5 條第 5 款
有禁止快取的限制；owner 已明確接受這個條款風險及可能被停用的後果，這不代表取得供應商授權。
Expand-only migration `045_transit_leg_cache.ts` 在既有 `044_trip_stop_replacements` 後新增
`transit_leg_cache`，以 `(trip_id, travel_date, from_lat, from_lon, to_lat, to_lon)` 為主鍵，
四個座標使用 `numeric(9,6)`。分鐘與線名（空線名表示步行）、shape GeoJSON 分別儲存，
`minutes_fetched_at`／`shape_fetched_at` 各自判定七天有效期，不因另一種資料更新而延長。
超過七天的資料不讀取，可在下次查詢成功時覆寫；trip 刪除時由 FK cascade 刪除整批快取。
每個成功路段立即 upsert，不包在整批 matrix 的交易內，所以後續失敗不會撤銷先前已付費的結果。
快取讀取失敗時不把它當成 cache miss 大量重查。兩個 endpoint 仍回
`Cache-Control: private, no-store`，不啟用瀏覽器／service worker 的 HTTP 快取。
`RAPIDAPI_KEY` 由 `.env` 經 compose 的 app-environment 傳入 API，不寫入快取、不記錄、不送瀏覽器；
不恢復已刪除的個人 key 或時刻表。
供應商規格：[route_transit](https://api-sdk.navitime.co.jp/api/specs/api_guide/route_transit.html)、
[shape_transit](https://api-sdk.navitime.co.jp/api/specs/api_guide/shape_transit.html)。

### Non-Japan Google Routes

已知非日本日程且設定 `GOOGLE_MAPS_API_KEY` 時，使用 Google Routes API `TRANSIT`。
沿用上述日程國家判定，只接受同一個已知國家；不硬編任何城市或額外國家清單。
必須在 **server key 所屬的 Google Cloud project 啟用 Routes API**，並在該 key 的 API restrictions
允許 Routes API；同一把 key 原有的 Places API (New) 權限保留。server key 不送瀏覽器；
地圖仍用獨立的 `GOOGLE_MAPS_BROWSER_KEY` 與既有 Maps JavaScript API 額度。

分鐘用 `POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`，
field mask 為 `originIndex,destinationIndex,status,condition,duration`。
Google `TRANSIT` 每批最多 100 elements；這裡每個 origin 搭配最多 100 destinations，
不為未使用的自我／住宿之間配對付費。N 是**矩陣元素數，不是 HTTP 請求數**：
有座標的 `n` 站與起／終住宿 `s,e`，`N ≤ n(n−1)+n·s+n·e`，
重複 ID 配對只算一次，相同 ID 的自我路段為 0 分鐘、不呼叫 Google。
每個 origin 有 `dᵢ` 個需要的 destinations，矩陣 HTTP 數為 `Σ ceil(dᵢ/100)`；
每批扣 `destinations.length` 個單位。Google matrix 不含線名或逐步運具，
所以分鐘列標示「大眾運輸／步行」，不誤標為純步行。

只有右側地圖分頁呼叫
`POST https://routes.googleapis.com/directions/v2:computeRoutes`，每個有座標、不同 ID 的相鄰路段一次。
field masks 為 `routes.legs.steps.polyline.encodedPolyline`、
`routes.legs.steps.travelMode`、`routes.legs.steps.transitDetails.transitLine.color`。
解碼逐 step polyline 成 GeoJSON，才能分開大眾運輸實線與灰色步行虛線；
不用整條 `routes.polyline.encodedPolyline` 混畫步行，也不以兩端座標補假直線。
Google 無路線時回 null；列表顯示估計／無法取得，地圖不畫該段，並註明「路線由 Google 提供」。
例：4 站、前後住宿且 ID 都不重複，分鐘查詢為 20 elements（5 個 matrix HTTP），
首次開右側地圖最多 5 個 computeRoutes HTTP；合計最多 25 個預算單位。

`computeRouteMatrix` 與 `computeRoutes` 共用 `google_routes` guard：
每 UTC 日 **2000 global／2000 account／2000 IP**。送出 HTTP 前，在同一筆交易原子預留整批元素，
不能把 100 elements 當成一次；shape 每個 request 扣 1。這是 app 的每日保護，不是月費或 Google quota 保證。
Google Routes 與 NAVITIME 的預留若在呼叫 `fetch` 前取消，會在原本的 window、
global／account／IP 三個 scope 同一筆交易退回；不會退到隔天或另一個身分。已開始 HTTP 的請求仍計費。
每個 API process 最多 4 個 Google Routes HTTP 同時進行，每次 timeout 8 秒、不重試；
矩陣與 shapes 各沿用整批 20 秒 deadline，停止排新工作並取消逾時 HTTP。
矩陣任何錯誤（包括無路線）整天回退直線，`travelNotice: transit_quota` 表示 guard 拒絕／HTTP 429
（或 matrix element 的 RESOURCE_EXHAUSTED），其他錯誤為 `transit_unavailable`。
shape 保留成功段，其餘 null；額度／服務失敗也透過 `travelNotice` 顯示 Google 文案，不寫 NAVITIME。

所有分鐘與 shape 一律以**該日當地 09:00**出發，轉成含時區的 RFC 3339 instant 送給 Google，
不是依停留時間推進的時刻表。日程本身沒有 timezone 欄，依序從當天地點、前後住宿、
當天 itinerary endpoints、日程國家 stops 取得時區；同一層多個時區或沒有時區時不付費，回 unavailable。
Google 的 transit 時刻表僅支援過去 7 天到未來 100 天；超出日期或服務範圍時照上述失敗路徑回退，
不偷偷換日期或改成開車。

**Owner 決定 Google Routes 結果完全不快取。** 不寫 `transit_leg_cache`、其他 DB、server cache、
localStorage 或 HTTP cache；只保留在當次 HTTP response 與開啟中的 dialog 記憶體。
拖曳／移除／儲存後仍可用同日期且座標相符的 dialog matrix，但左側永遠不套用分鐘。
儲存後，日期、地點集合、座標與前後住宿都沒變時，保留已付費的 Google 建議作為「還原」目標；
只更新版本與待查次數，不被重新讀取的直線建議覆蓋。資料變動則不保留，還原按鈕依真正目標標示交通或直線。
關閉後資料即丟棄；再次開啟不查 Google、仍顯示完整 N，按分鐘按鈕或開右側地圖才重新查詢。

供應商規格：[transit matrix](https://developers.google.com/maps/documentation/routes/transit-rm)、
[transit route](https://developers.google.com/maps/documentation/routes/transit-route)、
[computeRouteMatrix](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)、
[computeRoutes](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)。

Saving remains explicit and version checked:

- `PUT /api/trips/:tripId/days/:dayId/place-order` stores an order for places
  already assigned to the day.
- `PUT /api/trips/:tripId/days/:dayId/arrangement` atomically removes omitted
  located places, adds eligible unassigned places, and stores the candidate
  order.

Opening either comparison column's Google Map tab first reserves one authenticated `POST /api/maps/load`
unit, then loads the Maps JavaScript API only after the reservation succeeds.
The shared database budget allows 310 loads per Los Angeles calendar day—10
below the Google Cloud Maps JavaScript API quota of 320 loads per day—and
resets with Google's Pacific-midnight window. Exhaustion returns
`429 maps_daily_limit`; script, network, and Google
authentication failures remain inside the map panel so the route list stays
available. The separate Google Places UTC-day budget is unchanged.

Flights and lodging are reached from the 行程 navigation: on desktop the rail
shows 總覽／航班／住宿 under 行程; on mobile the same three appear as a segment
strip at the top of the 行程 panel.

## Shared flights and lodging (Issue #74)

`POST /api/trips` requires `name`, `startDate`, `endDate`, ordered `countryCodes`
and `flights: { outbound, return }`. Each flight is:

```ts
{
  serviceNumber: string; // optional; send "" when unknown
  carrier: string | null;
  departureAirport: {
    name: string;
    timeZone: string;
    latitude?: number;
    longitude?: number;
  };
  arrivalAirport: {
    name: string;
    timeZone: string;
    latitude?: number;
    longitude?: number;
  };
  departureLocalDateTime: string; // YYYY-MM-DDTHH:mm
  arrivalLocalDateTime: string;   // YYYY-MM-DDTHH:mm
  departureUtcOffset?: string | null; // required only for a repeated local hour
  arrivalUtcOffset?: string | null;
}
```

All endpoint local dates must lie within the trip dates, even outside the route.
Named IANA zones and existing DST validation apply. Each arrival must be strictly
after departure; the return must depart after the outbound arrival. Creation
persists the trip, stops, days, owner, airports and both flights in one transaction:
any error rolls everything back. Historical `create_trip` responses replay before
the new flight requirement is checked. The outbound arrival uses the first stop;
the return departure uses the last; the other two endpoints are outside the route
(`countryStopId: null`). A nonblank service number remains the flight title; when
it is blank the API stores `""` and derives a readable route title from the airport
codes or names. Airport coordinates are additive and optional, but latitude and
longitude must be supplied together and within their geographic ranges. Legacy
payloads containing only airport name and zone remain valid. New travel items
select all active members explicitly at save time, not the `null`
pending-confirmation party. For repeated DST hours, supply one of the valid UTC
offsets. Omitting an offset on PATCH retains the current occurrence only when its
local time and timezone are unchanged; explicit `null` clears that choice and
normal endpoint validation applies.

The web form lazy-loads a pinned offline IATA airport dataset when a flight editor
opens. It searches code, English name and city, derives IANA zone and coordinates,
and keeps manual airport/time-zone entry as an advanced fallback. The generated
module is 669,959 bytes raw and 232,180 bytes (226.7 KiB) with gzip level 9.
Regenerate it with `./scripts/generate-airports.py`; the script verifies the pinned
CSV SHA-256 before writing deterministic output. Source commit, retained fields,
license and TimeZoneDB provenance are recorded in the generated header and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Trip members use these idempotent, versioned travel routes:

| Route | Body additions to the travel input | Result |
| --- | --- | --- |
| `POST /api/trips/:tripId/flights` | `expectedTripVersion` | `{ item }`, 201 |
| `PATCH /api/trips/:tripId/flights/:itemId` | `expectedVersion` | `{ item }`, 200 |
| `POST /api/trips/:tripId/lodgings` | `expectedTripVersion` | `{ item }`, 201 |
| `PATCH /api/trips/:tripId/lodgings/:itemId` | `expectedVersion` | `{ item }`, 200 |

Every mutation requires `Idempotency-Key`. Lodging input is
`{ hotel: { name, address?, latitude?, longitude?, timeZone, sourceUrl? }, countryStopId,
checkInLocalDateTime, checkOutLocalDateTime, checkInUtcOffset?, checkOutUtcOffset? }`;
hotel name, country stop and named timezone are required. Address, coordinates and
source URL are optional: omitted facts remain unchanged on reuse/PATCH, while an
explicit `null` clears them. Supply both coordinates when changing or clearing them.
New places default omitted facts to null. The optional offsets use the same repeated-hour rules as
flights. Checkout cannot precede check-in. Both endpoints use the same hotel, stop
and timezone. Undeclared nested airport/hotel fields are rejected with 400.
Google hotel search reuses `POST /api/trips/:tripId/trip-places/search` for candidates
only; selecting one does not add it to the wishlist. Manual hotel entry is supported.
Travel PATCH changes only the service/hotel name, carrier where applicable,
airports/hotel and endpoint times; notes, source URL, money, booking/confirmation
details, participants, constraints and locks are retained. Locked items still
require unlocking. Delete uses `DELETE /api/trips/:tripId/items/:itemId` with
`expectedVersion`; existing lock/unlock routes continue to apply.
An itinerary item can store at most 20 constraints, whether supplied with the
item or added later. The item dialog creates at most one initial constraint; the
larger API allowance supports imported and incrementally maintained itineraries
without allowing cumulative replay responses to grow without bound.


The overview lists every stored flight by departure instant: first 去程, last 回程,
intermediate flights 其他航班. Fewer than two produces a nonblocking 尚未填寫航班
prompt and add form. Old flights are neither migrated nor deleted. The 住宿 tab,
between wishlist and itinerary, manages stays in check-in order. 行程 no longer
offers flights or lodging in its item dialog; its existing cards link to the
overview/lodging editors. Mounted skeleton, wishlist and travel panels reload via
the revision mechanism; skeleton/planning APIs keep returning every travel item.
Itinerary lock/unlock and constraint edits also broadcast that revision. An editor
already open keeps its original optimistic version rather than silently rebasing.
Already-open planner drafts are not automatically regenerated (which would make
paid route calls); their existing plan-basis check refuses stale application.

Travel endpoints use legacy `places` rows marked `travel_only = true`, never
wishlist rows. Within a trip, a travel place with the same trimmed case-insensitive
name and timezone is reused. Submitted hotel address, coordinates and source URL
update that travel-only place and its version, unless any referencing item is
locked. A place referenced by a non-travel item is never changed this way.
The lodging editor compares facts with its opening snapshot and omits untouched
ones, so a time-only save cannot overwrite another stay's shared-hotel enrichment.
PATCH retains an unchanged existing airport/hotel endpoint, including mixed-use
legacy places and their routing facts. Eager wishlist mirroring skips travel
places; reconciliation also archives active travel mirrors introduced by a retained
release and clears their votes/assignments/legacy day rows, retaining contributions.
Explicit intake cannot unarchive a travel-only identity: it returns
`409 travel_place` and preserves its archived row and contributions.
Discovery excludes provider identities backed by travel-only places even when
archived; ordinary removed wishlist identities remain eligible for recommendation.

Migration `016_travel_places` adds the non-null flag (default false), marks places
used by at least one flight/lodging endpoint and no other item type, and archives
their linked wishlist rows. It clears votes, day assignments and legacy
desired/excluded-day rows, but retains contributions, legacy places, all formal
items and endpoints. Mixed-use places remain unchanged. **Down only drops the
flag; it does not unarchive wishlist rows or restore cleared votes/assignments.**
The #74 implementation and added regression coverage are UNVERIFIED until the
coordinator runs the API, migration and browser checks.

## AI discovery claim sources (Issue #65)

Each `CandidateProposalDto` from a new research run contains
`recommendationSentences` and `tradeoffSentences`: ordered `{ text,
evidenceIds }` entries. `text` is plain text with markdown links and citation
markers removed. `evidenceIds` reference entries in that proposal's `evidence`
and may only point to URLs the run's own web search returned; an empty list
means the sentence is model inference and is shown as unverified. Cited pages
are stored as `web-source` evidence of that run, expiring 30 days after they
were observed. Proposals created before migration `013_discovery_claims` keep
`null` sentence lists and show their original `recommendation` and `tradeoffs`;
no sources are invented for them.

Every evidence entry reports `isStale`: true once its `expiresAt` has passed,
or, for web sources stored without an expiry, 30 days after `observedAt`.
Stale evidence is labelled for re-checking and is never refreshed automatically.

## AI discovery questions (Issue #66)

Discovery mutations require an `Idempotency-Key` and the current version.
Generation is limited to 10 model starts per account per fixed UTC hour and 6
per trip because each run incurs OpenAI and Google work. The counters are stored
independently from idempotency responses and are charged immediately before
`model.plan`; model failures and later Google quota refusals never refund them.
A local Google budget refusal removes only the idempotency claim, so the same key
may retry after quota becomes available without bypassing the OpenAI limits.

`GET /api/trips/:tripId/discovery` is read-only. Wishlist removal, legacy-place
deletion, and trip-place reconciliation reopen stale accepted proposals in
their own mutation/reconciliation transactions rather than attributing writes
to the member who reads the discovery workspace.

- `PUT /api/trips/:tripId/discovery/brief/questions` accepts
  `expectedVersion` and ordered `answers` entries `{ question, answer }`.
  `answer: null` explicitly means skipped and unknown. Saving answers increments
  the brief version even though its text is unchanged, so the next generation
  and its idempotent replay use one consistent answer set. Changing the brief
  text clears all earlier question answers.

`DiscoveryBriefDto.questionAnswers` reloads saved answers and skips. Planning
and research receive both forms: answered questions constrain the request,
while skipped questions remain unknown and must not be guessed or asked again.
Migration `014_discovery_feedback_answers` stores these answer records. The
legacy `discovery_feedback` table and its columns remain for migration
compatibility, but the application no longer reads, writes, or exposes them.

## AI discovery near the traveler (migration 047)

Owner decision 2026-10-22: 「AI 建議先用手機目前定位（要授權），拒絕或抓不到就用今晚住宿；位置不存。」

- When 調查 starts the checklist (`POST /discovery/clarification`) and again when it queues
  research (`POST /discovery/research`), the web asks `navigator.geolocation` once (secure page
  only; `enableHighAccuracy: false`, `timeout: 8000`, `maximumAge: 600000`; the client gives up
  after 8.5 s so an unanswered permission prompt never blocks 調查). On success the body carries
  `near: { latitude, longitude }` rounded to 3 decimals; on denial, timeout or no API it carries
  nothing. The idempotency key ignores `near`, so a retry with a re-read position replays.
- The server picks the search center in this order: `near` (`source: "device"`); else tonight's
  booked lodging (`source: "lodging"`): the lodging whose check-in local date ≤ today < check-out
  local date, today being the date in the check-in's time zone (the trip's if unusable), and only
  when the hotel has coordinates; else no center (unchanged behavior). An invalid `near` (not two
  finite numbers, latitude outside −90..90 or longitude outside −180..180) is `400 validation_error`.
- The checklist worker, the plan and the research model receive the center with "within about
  2 km walking distance"; with a center the checklist must not ask where the traveler is or stays.
  Every Grounding Lite `search_places` call carries `locationBias.circle` (center, 2000 m), and each
  discovered place gets its straight-line distance so research prefers walking distance. The plan
  calls that area exactly 「附近」 and no model may write the coordinates or a place inferred from
  them into the stored plan, checklist or sentences, which every member sees. Every other rule
  (cited sources, zh-TW, Places verification) is unchanged.
- The clarification and research start responses return `searchCenter: { source, label, position } | null`
  (label: the lodging's name; position: the lodging's coordinates, a trip place every member already
  sees, and `null` for the device — the phone position is never echoed) for the member who sent them; every other read
  returns `null`. A replayed research request reports the job it queued (its stored position while
  active, else none), not the retry's position. The web shows one line, under the checklist it
  belongs to and on that member's own job: 「以你目前位置附近搜尋」 or 「以今晚住宿「{name}」附近搜尋」.
- 位置不存: the position is never stored except on `discovery_jobs.near` (migration
  `047_discovery_job_near`, expand-only nullable jsonb) while the job is queued or running; success,
  failure and the stale-job sweep set it to NULL, like `client_ip`. Coordinates are never logged
  (`discovery_run_timing` logs only `searchCenter: "device" | "lodging" | null`). The lodging
  center is recomputed from itinerary data and never stored.

### 交通方式・時間 (migration 048)

Owner rule 2026-10-22: 「當用戶問附近要做什麼之類的要求時，一定要反問目前交通工具，然後時間是 5 分鐘以內、6–10 分鐘、15 分鐘以內，或以上都可以。」

- Whenever 調查 has a search center (device or lodging), the dialog shows two required chip
  questions above the AI checklist — 交通方式「步行・大眾運輸・計程車／開車」 and 時間「5 分鐘以內・6–10
  分鐘・15 分鐘以內・都可以」 — even when the AI asks nothing. They are fixed UI, not model
  questions; the checklist model is told never to ask about transport, travel time or distance when
  a center exists. 「開始找地點」 stays disabled until both are picked. Nothing is preselected the
  first time; the last pick is kept in `localStorage` (`along-the-way:discovery-reach:{accountId}:{tripId}`,
  cleared on logout) and preselected next time. When the page does not know this brief's center (a
  reload, or a checklist another member started) it asks `POST /discovery/clarification` again (no
  model call for an existing checklist) and shows the chips before research.
- `POST /discovery/research` takes `reach: { mode: "walk" | "transit" | "taxi", maxMinutes: 5 | 10 | 15 | null }`
  (`null` = 都可以). Anything else is `400 validation_error`; a start with a center and no `reach` is
  `409 reach_required`. `discovery_jobs.reach` (expand-only nullable jsonb with a CHECK) keeps the
  two enum values with the job; they are not personal data, so they are not cleared at job end.
  `discovery_run_timing` logs `reachMode`, `reachMaxMinutes` and `droppedTooFar` (a count).
- `DISCOVERY_REACH_METERS_PER_MINUTE` (contracts) is an ESTIMATE of straight-line meters per minute:
  walk 60, transit 185, taxi 250. 5/10/15 minutes allow walk 300/600/900 m, transit 925/1850/2775 m,
  taxi 1250/2500/3750 m from the center. That radius replaces the 2000 m `locationBias.circle` and
  is written into the research prompt (「只推薦從中心點出發，{交通方式}約 N 分鐘內可到的地方」). 都可以
  keeps the 2 km bias and no limit.
- Hard filter: after verification, every proposal farther than the radius (or without coordinates)
  is dropped before saving. No shortfall code means "too far", so only the count is logged.
- Each new row of the member's own job shows 「直線 X m・{交通方式}約 N 分鐘（估計）」, N =
  ceil(X ÷ speed). The page computes it from the position it sent (or the lodging's position);
  nothing distance-related is stored, so the line is gone after a reload and other members never
  see it — per-place distances from the phone would let anyone recover its position.

## AI proposal confidence and rejection wording (Issue #78)

New discovery research no longer asks the model for a confidence label, stores
one, or returns one in `CandidateProposalDto`. Existing database rows and
idempotent replies that contain `confidence` remain readable, but the field is
ignored and is not exposed by the API or candidate cards. The proposal action
is labelled 「不要再推薦」; rejected cards and the prior-decisions list use
「已設為不要再推薦」. The action still excludes the same place from later
research runs.

Migration `018_drop_confidence_writes` keeps the `candidate_proposals.confidence`
column, its value check and `NOT NULL`, and gives it a `medium` default so the new
release can stop writing it while every row stays readable by the previous
release after a rollback. The default value carries no meaning and is never
shown. Down migration only drops the default; a later contract migration can drop
the column. Known rollback limit: idempotent discovery replies stored by this
release omit `confidence`, so after a rollback the previous release cannot
replay them; retrying such a request with the same `Idempotency-Key` fails,
while new requests work. Earlier field removals (#73, #76) share this limit.

## Selected itinerary places and pending dates

`TripPlaceDto.selectedForItinerary` is the shared itinerary selection, independent
of votes, provider readiness, and whether the place currently has a date.
`unplacedFromDate` is the nullable original local calendar date of a removed
placement; it is not an inferred timestamp or a proposed replacement date.

- A new Pocket candidate is unselected. Assigning a day selects it and clears
  `unplacedFromDate`; accepting a whole-trip plan uses the same assignment writer.
- Removing a day keeps the place selected and records the actual previous
  `TripDay.date` before the legacy synchronization trigger deletes the assignment.
  Removing an already unassigned candidate does not select it.
- Formal timed-item create/update/delete synchronizes the same canonical place
  identity transactionally. A remaining timed placement or day assignment clears
  the prior date. Removing the last timed placement keeps selection and records
  its original local date only when that date is unambiguous.
- Plan's pending list contains selected places with neither a timed item nor a
  day assignment. Its source picker separates these from never-selected Pocket
  candidates. Missing coordinates remain visible but cannot be scheduled there.
- Reassigning a pending place preserves its stable identity, selection and votes,
  removes it from pending, and clears the old date. The default picker date is the
  next available TripDay after a known original date, otherwise the first TripDay;
  the member can choose another date.
- Merge preserves either source's selection. A current placement clears prior
  history; conflicting or unknown selected histories remain explicitly unknown
  rather than inventing one original date. Archived places are excluded from the
  active pending list.

Migration `022_trip_place_selection` is additive: a defaulted selection column,
a nullable date, and a validity constraint. Backfill selects only currently
observable day assignments or timed placements. Already unassigned old records
retain the current Pocket classification; lost historical selection and dates
are not reconstructed. This is a tracking cutover, not a claim about past visits.
Stored `tp:*` idempotent replies are normalized from their own placement snapshot,
not current live state, with unknown prior dates left null. A reply-insert trigger
keeps replies from retained binaries readable after a migration-free rollback.
Fresh votes reconcile existing placements within the same trip-content transaction
before storing their reply. This clears stale selection/history left by a retained
writer even when voting is the first forward request; the vote itself does not
select an unplaced candidate.
Down removes the new schema and cannot retain the new selection/history data;
it is not the deployment rollback procedure.

### Accept AI proposals directly onto a day

`POST /api/trips/:tripId/discovery/proposals/schedule` requires an
`Idempotency-Key` and `{ "tripDayId": "uuid", "proposals": [
{ "proposalId": "uuid", "expectedVersion": 1 } ] }` with 1–100 distinct proposals.
It accepts pending proposals (including their active-member votes) and assigns
their places to the requested trip day in one transaction. Already accepted
proposals reuse their live wishlist places, validate those places' current
coordinates rather than the original proposal snapshot, and still require the
current proposal version. Merging a linked wishlist place advances the proposal
version, so a pre-merge request conflicts instead of silently scheduling the merge
target. Pending proposals must have coordinates before acceptance. A stale,
rejected, accepting, missing or unlocated candidate fails the whole command; no
acceptance, assignment, vote, event or replay record is committed.
The day must belong to the trip. Existing timed-item and cross-day assignment
conflicts remain unchanged; assignment selects the place and clears its prior date.
Success returns the existing `{ discovery }` workspace, parsed by
`parseScheduleDiscoveryProposalsResponse`; a retry with the same key returns the
stored response without repeating effects. No database migration is required.

Only the trip creator (`owner`) may call this command, accept a proposal, or use
「不要再推薦」 (`POST .../proposals/:proposalId/reject`). The backend returns
`403 forbidden` / `Only the trip owner can do that` for other active members;
non-members retain `404 trip_not_found`. All members keep their existing voting,
manual place intake and Pocket-place scheduling permissions. Existing route
response shapes and stored-reply compatibility are unchanged.

## Activity participants (Issue #21)

This slice of [Issue #21](https://github.com/tzurae/along-the-way/issues/21)
connects explicit participant selection, transactional persistence, reload, and
daily cards. It does not implement automatic planning, participant columns, or
the personal current/next and offline features of Issue #28.

- `TripMemberDto.id` is the stable membership UUID. `userId` remains the account
  identity used for authorization and membership removal; the two are not aliases.
- Create and update item requests require `participantMemberIds`: `null` means
  pending confirmation; an explicit collection must be nonempty, duplicate-free,
  and contain membership IDs from this Trip. Generic item routes do not default
  to the whole roster; the dedicated travel routes explicitly select active members.
- Responses expose `participants`, either `null` or enriched entries containing
  `memberId`, `displayName`, `email`, and `removed`. Adding another participant
  updates the existing item and preserves its stable ID.
- New selections must be active members. An ordinary edit can retain an already
  selected, subsequently removed member; the card and dialog identify that history
  instead of silently erasing it. Explicit deselection removes the association.
- The item dialog uses roster checkboxes, resets an abandoned draft when reopened,
  and retains submitted selections when validation or version conflicts fail.
- Daily cards show the full start and end alongside the explicit participants.
  Single-endpoint activities, reservations, meals, and free time derive their end
  from elapsed duration and the endpoint's IANA timezone, not the browser timezone
  or a global Trip timezone. No second endpoint is stored just for display.
- A derived end obeys the same Trip-date rule as an explicit end endpoint: the
  local date of start plus `durationMinutes`, in the start's zone, must fall
  within the Trip's first and last dates; otherwise the API returns
  `validation_error`. Dates, not instants, are compared because a time zone
  transition can move the local date backward. A stored
  duration beyond Temporal's representable range (written before this rule or by
  an older binary) shows an explicit per-card message instead of an End time.
- An endpoint's `countryStopId` is `null` only for a flight or transport endpoint
  outside the Trip's Country Stops, such as the home airport (migration
  `012_endpoints_outside_route`). That endpoint uses its Place's time zone or the
  one the member enters, never a Country Stop's. Every other item, lodging
  included, still requires one of the Trip's Country Stops.

Migration `008_activity_participants` assigns real IDs to existing memberships,
adds trip-scoped participant associations, and upgrades existing cached mutation
replies without replacing their historical account values or member order.
Previously unspecified item participants remain `null`. A `mutation_requests`
BEFORE INSERT trigger also normalizes later legacy-binary replies: missing Trip
member IDs resolve to real memberships, and missing item participants capture
that item's explicit associations and labels at insertion time. No association
means `null`, never the whole roster. Complete replies and unrelated cache
families remain unchanged; replay does not re-read current parties or labels.

Initial-candidate verification on 2026-10-03 in the isolated
`along-the-way-issue21-participants` Docker project: typecheck, 109 unit tests,
34 HTTP/PostgreSQL integration tests, and all seven Chromium scenarios passed.
The participant scenario exercised
independent 10:00–12:00 and 11:00–13:00 activities, reload, a shared stable item,
pending confirmation, a fourth member, stale-edit rejection, lock/unlock, and
removed-member history. Direct browser operation also saved and reloaded a party;
desktop and a 390px mobile case with a shorter participant email showed the full
time range without horizontal overflow. This is not proof for longer labels.

Integration tests require a disposable `TEST_DATABASE_URL`. The migration
regression creates and uses the sibling `along_the_way_participants_migration`
database on that same isolated PostgreSQL server, so the test role needs
`CREATEDB`. Never run their reset operations against retained or production data.

**Rollback cache interoperability: PASS after repair.** The original candidate
returned HTTP 409, `Stored mutation result is invalid`, after an old binary
inserted a new cached Trip reply into an already-upgraded schema. The approved
008 insertion trigger fixed that actual scenario: old create/retry returned 201,
and forwarding without migrations returned 201 with the same Trip ID/version
and a genuine membership UUID distinct from the account UUID. Real old constraint,
lock, and unlock requests also replayed their original explicit one-person party
out of a two-member roster after the live party was cleared; their original
versions 2/3/4 survived while live version 5 remained `null`. An old pending
create replayed as `participants: null`. Current typecheck, 109 unit tests, and
35 HTTP/PostgreSQL integration tests passed.

Post-review public-interface verification supersedes the initial passing matrix:

- Mobile width and native participant-picker reading: **PASS** after the approved
  repairs. Longer emails initially produced 439px/390px; card-only wrapping was
  insufficient. Shrinking/wrapping Members and picker labels restored the same
  independent case to 390px/390px, with the full 10:00–12:00 range and both
  historical/current emails. The picker measured 324px visible/content width and
  retained the exact checked parties. Wrapping exposed an 8px adjacent-row text
  overlap; `auto-rows-min` then preserved full content height within the unchanged
  256px vertically scrollable group. Direct browser operation measured 66px/86px
  rows with content inside each row and showed the removed member's complete
  label. Current typecheck and both web image builds passed. The same extended
  participant Chromium scenario failed before the row fix and passed afterward
  (one scenario, zero retries), including page/picker width and label containment.
  No global overflow hiding or truncation was added.
- Accepted extreme duration: **PASS** after the approved Trip-date rule. Before,
  the API returned 201 for `durationMinutes: 9007199254740991`; opening the Trip
  threw `RangeError` from `Temporal.Instant.add` and left the React root empty.
  After repair, that value returned 400 for an activity and for free time; from
  10:00 on the last Trip date, 839 minutes saved with End 23:59 and 840 minutes
  returned 400. Old-binary writes of the same value and of the exact Temporal
  limit opened in the repaired UI without page errors: the former card showed the
  explicit message, the latter its true End (`+275760-09-13 09:00`). Saving the
  unchanged legacy item showed the API error in the dialog; editing it to 60
  minutes saved with End 11:00. The extended validation regression failed with
  `expected 201 to be 400` when the rule was removed and passed when restored.
  Typecheck, 109 unit tests, and 35 HTTP/PostgreSQL integration tests passed.
  All seven Chromium scenarios then passed (zero retries) on a freshly reseeded
  disposable database; an earlier run against integration-test leftovers failed
  only the summary scenario's documented reload precondition.
- Calendar-date rollback: **PASS** after repair. A fresh-context final review
  showed the first rule compared instants with the next day's start, which is not
  equivalent where `America/St_Johns` fell back at 2009-11-01 00:01 to
  2009-10-31 23:01. The new regression failed against that rule (a reservation
  ending 2009-10-31 23:30 on a 2009-11-01-only Trip returned 201). After comparing
  local dates against both Trip bounds, the public API rejected that case and
  accepted 23:30 + 60 minutes on a 2009-10-31-only Trip for all four duration
  types; the UI showed End 2009-10-31 23:30 (-03:30). Tokyo 839/840 minutes and
  the extreme value kept their results. Typecheck, 109 unit tests, 36 HTTP/
  PostgreSQL integration tests, and all seven Chromium scenarios (zero retries,
  freshly reseeded database) passed.

A second fresh-context final review accepted the calendar-date repair (no
blocking implementation finding) but left the whole Issue **UNVERIFIED** because
11 broader criteria and a final source manifest lacked direct evidence. The
following public-interface evidence was then recorded on the same images (public
HTTP with real magic-link sessions plus Chromium in `Pacific/Honolulu`):

- Field persistence: eight fully populated Places and 13 items covering all seven
  types reloaded with zero mismatches. Flight, lodging, transport, reservation,
  meal, and activity each had one item with every field non-null; free time had
  notes and duration, with source and money null. Endpoint Place, Country Stop,
  local time, and IANA zone also matched.
- UTC ordering: Day 2 lists Tokyo 10:00 (01:00Z), Taipei 09:30 (01:30Z), Tokyo
  15:00, then the Los Angeles 00:30 departure (07:30Z), opposite to wall-clock and
  creation order, identically in the API and the reloaded UI; the LAX→NRT flight
  keeps its local times, zones, and Day 2/Day 3 projections.
- First-day priorities list exactly the Taipei→Tokyo arrival, Osaka check-in, and
  first-evening free time, excluding a Day 3 arrival, a Day 3 check-in, Day 2 free
  time, and a Day 1 activity.
- Audit: create, edit, lock, unlock, and delete by alternating Owner/Editor each
  produced one event with the exact actor, target, request-window time, and a
  summary without the private note or confirmation values.
- Authorization: an outsider (member of another Trip) and a removed member got
  404 `trip_not_found` for all 13 Place/Item/Constraint read and mutation calls;
  borrowing the outsider's own Trip ID returned 404/400. The owner's Trip and
  skeleton were unchanged.
- Privacy: validation, invalid URL, conflict, locked, over-long, malformed JSON,
  foreign-reference, and DB-outage (500, sandbox DB briefly stopped) responses
  contained no private sentinel or SQL; API, worker, and DB logs contained no
  sentinel, SQL, or secret. During the outage the unchanged email worker exited
  on an unhandled connection error and was restarted by Docker seven times.
- Edge probes: Apia's skipped 2011-12-30 (reject when the Trip ends Dec 30,
  accept and show End 2011-12-31 12:00 +14:00 when it ends Dec 31) and the
  9999-12-31 boundary (23:59 accepted, year 10000 rejected).
- Source identity: 24 changed or untracked files (base `4f2439e`) are hashed in
  the evidence manifest; all 14 API/contracts sources match the running API image,
  and rebuilding API and web hit cache for every step with unchanged image IDs.

Not verified: an untouched data-bearing 008 down/up round trip (the repository
supports migration-free rollback only).

## Member votes (Issue #73, replacing #67's five preference levels)

Each active member has one vote per wishlist place and per pending AI proposal:
voted or not. A single active member can vote (owner decision #127, replacing
#73's two-member minimum); a trip with no active member returns
`409 voting_unavailable`. Removed members' votes never count.

- `PUT /api/trips/:tripId/trip-places/:tripPlaceId/vote` returns `{ tripPlace }`.
- `PUT /api/trips/:tripId/discovery/proposals/:proposalId/vote` returns
  `{ proposal }`; only `pending` proposals accept votes. A retried vote stored
  before 0.8.0 (whose stored result is the whole workspace) still replays the
  proposal.

Both require an `Idempotency-Key` and a body of `{ "voted": true }` or
`{ "voted": false }` (set-state, no `expectedVersion`). They always change the
signed-in member's own vote; a member ID in the body is ignored. A retry of a
stored request replays its original result.

Place and proposal DTOs carry `voters` (`memberUserId`, `memberEmail`,
`memberDisplayName`), `voteCount`, `ownVote` and `votingAvailable`. The
wishlist is ordered by vote count, ties keeping creation order; voted cards are
tinted and the top-voted cards (at least two votes) slightly more. AI proposals
are ordered by vote count too. Votes update optimistically, roll back on failure,
and are then confirmed by a fresh list read. Accepting a proposal copies active members' votes to the
wishlist place without duplicates; merging places keeps the union of votes.
Day and whole-trip plan drafts prioritize places by vote count and no longer
show preferences or conflicts. Formal itinerary items are never changed.

Votes and historical contributions never block removing a wishlist place or
deleting a legacy place. Itinerary-tab deletion is refused with `place_in_use`
only when a formal itinerary endpoint references the place. Wishlist removal
works even in that case and leaves the legacy place and formal items intact.
Accepted AI proposals return to `pending` when their wishlist place is removed
or deleted, retaining proposal votes so members can accept them again.

Migration `015_member_votes` clears the retired five-level choices but keeps
the `member_place_preferences` table so a rolled-back previous release still
runs (a later contract migration removes it). It drops migration 005's shared
delete trigger and function, adds both vote tables with composite foreign keys,
and lets an accepted proposal keep a null accepted place. `down` restores the
trigger, function and original proposal check, and refuses to run while an
accepted proposal's place has been deleted. Stored idempotent replies from
before 015 are read with empty vote defaults; zh-TW labels of historical
preference events are kept.

## Simplified wishlist (Issue #76)

Explicit Google search and Maps-URL intake refuses an already-active provider
identity in the same trip with `409 already_in_wishlist` (「這個地點已在想去清單。」).
No additional wishlist row or contribution is written. Removing and re-adding an
ordinary identity unarchives its existing row but resets
`selectedForItinerary=false` and `unplacedFromDate=null`; travel-only identities
still return `409 travel_place`. Google and Wikimedia intake finishes before the
atomic database transaction opens. Manual intake and the possible-duplicate/merge
flow are unchanged. AI acceptance continues to reuse an existing wishlist identity.

`TripPlaceDto` exposes `notes` and `sourceUrl: string | null`, not contributions.
The source is the earliest contribution's URL, falling back to the legacy
place's URL. Contributions remain internal intake/merge history. Intake notes
are the shared place notes on both `trip_places` and `places`, with their
existing version/sync watermark maintained. Cards show notes and
「開啟原始來源」 directly. Stored replies from older releases still parse:
without `sourceUrl`, the old contributions supply it, otherwise it is null.

`POST /api/trips/:tripId/trip-places/:tripPlaceId/remove` requires an
`Idempotency-Key` and `{ "expectedVersion": number }`. Any active member can
remove a place after confirming 「從想去清單移除」. Success and replay return
204; stale active-place versions return 409. Removal archives only the wishlist
row and deletes its votes, day assignment, and legacy desired/excluded-day
sources. It never changes legacy places, formal items or endpoints. The event
is `trip_place.removed` (「把地點移出想去清單」). The contribution-withdraw
route and UI are gone; historical event labels remain readable.

Wishlist removal, itinerary deletion, and trip-place reconciliation of an
archived or missing accepted place reopen all its accepted proposals to
`pending`, clear `decided_by`, `decided_at`, and `accepted_trip_place_id`,
increment the proposal version, and record `discovery.proposal_reopened`.
The canonical proposal for a provider identity is the newest proposal in the
trip in **any status** (run
creation time and ID, then proposal creation time and ID). Only when that
canonical proposal is itself being reopened does it receive `reopened_at`;
all older reopened acceptances remain hidden, superseded pending rows. Newer
rejections and acceptances on active wishlist places remain authoritative.
Active members' votes are unioned without duplicates only onto a reopened
canonical proposal or a canonical pending proposal in the latest run, never
onto an accepted or rejected proposal. The `reopened_at` marker keeps a reopened
canonical candidate's original ID and evidence actionable across earlier
research runs until the next successful research run.
That run supersedes every earlier pending reopened candidate. If it recommends
the same provider identity, its new candidate inherits active members' votes
without duplicates; otherwise the old candidate disappears. Accepting or
rejecting again also clears the marker. Unrelated superseded candidates stay
hidden. Only active members' votes count and carry into an accepted wishlist place.
Discovery GET repairs stale accepted proposals only when needed, in a separate
transaction locking the trip before proposals. Mutation response projections
are read-only; wishlist reconciliation already holds that same trip lock.
Research excludes active wishlist identities, rejected places and travel
identities, not ordinarily removed wishlist places.

Migration `017_wishlist_simplify` first fills null wishlist notes from existing
non-null legacy notes, including pre-upgrade intake rows whose versions already
match. Only where both notes are null does it backfill both from distinct
non-empty contribution notes in creation order, separated by a blank line and
capped at 10,000 characters. Neither path advances either place version or the
reconciliation watermark. Non-null legacy notes are never overwritten, and
outstanding legacy edits still reconcile on the next wishlist read. The migration
adds `reopened_at` and reopens historical accepted proposals with missing/archived
wishlist places using the same canonical-card and active-vote-union rules,
and records an event for each reopened proposal.
**Down only drops `reopened_at`: the note backfill is a safe no-op on downgrade;
prior notes and proposal decisions are not restored, and reopening events stay.**

Implementation and added API, migration, contract and browser regressions are
UNVERIFIED until the coordinator runs validation, including the real UI at 25080.

## 下次還要來 (migration 049)

Owner request 2026-10-23: 「像我剛剛去到一個點覺得很不錯，下一次來京都可以再去，所以可以留下一個紀錄讓我之後可以推薦。」
Visibility: 「跟我一起出遊過的家人都看得到」.

Any trip place's detail (地點, 行程, 安排) has a 「下次還要來」 toggle with an optional
one-line reason 「為什麼（選填）」 (trimmed, at most 280 characters, blank stored as null).
A keep belongs to the user and the canonical place (`place_keeps`, unique per
user and `place_identity_id`), not to the trip, and remembers the trip it was first kept from.

- `PUT /api/trips/:tripId/trip-places/:tripPlaceId/keep` `{ note?: string | null }`
  (Idempotency-Key) marks or re-notes; `DELETE` on the same path removes the
  caller's keep (204, also when there was none). Both require active membership of `:tripId`.
- `GET /api/trips/:tripId/place-keeps` lists keeps by the caller and by every user who
  currently shares at least one active trip membership with the caller. Keepers are named
  by nickname only (null when unset; the UI says 「家人」); emails are never returned. The
  source trip's name and start date appear only while the caller is still a member of it.
  `alreadyInTrip` means an active place of `:tripId` has the same place identity.

地點 shows 「家人說下次還要來」 above 口袋名單 when that list is not empty (three rows, then
「看全部」). 「加入口袋名單」 uses the ordinary add-place API: Google places by provider ID,
manual places by copying name, type, address, coordinates and time zone. A copied manual
place gets a new place identity, so its keep row still offers 「加入口袋名單」 afterwards.
Migration `049_place_keeps` is expand-only; down drops the table.

## Mobile Today and read-only offline trips (Issue #28)

「今天」 is the first trip tab and the default when an actual TripDay matches
the current instant in that day's IANA time zone; otherwise 「總覽」 remains
the default. `?trip=<id>&tab=today&day=YYYY-MM-DD` preserves the selected trip,
tab and valid day across reloads and browser history. Automatic corrections replace
the current history entry and wait for the destination trip's model. Other tabs
remain mounted; a successful Today sync publishes a separate read-refresh revision
so itinerary and lodging update without a Today reload loop.
With #27 enabled, SSE refreshes use that same `workspaceRevision`, while only
local mutations advance `placesRevision` and its mutation-to-Today effect.
An old trip's notification cannot supersede an in-flight URL/Back navigation.
The offline shell suspends SSE and its retry timers; recovery retains #28's
single-flight authenticated read probe. Day-window and place-order saves await
the local itinerary load before publishing the refresh, including Today's
offline snapshot. Recent changes use the authorized `/history` projection,
not the removed skeleton event list.

The shared `resolveDayTimeZone` contract uses this precedence:
located lodging for the night (then the previous night), located wishlist places
assigned to the day in their saved order, then formal item endpoints. Today
explicitly falls back to the first country stop's zone. An unresolved zone is
shown as unknown; neither the device nor server zone is substituted. The device
clock supplies only the current instant. Before departure the page shows the
countdown and first fixed item; after the trip it shows completion and reviewable
dates rather than a next destination.

The read model uses the authenticated trip, skeleton and saved wishlist GETs.
It does not call planning, discovery generation, place enrichment or route
providers. Flights, lodging, transport, reservations/meals, activities and free
time remain formal itinerary items. Day membership includes both formal endpoint
projections and normalized intervals overlapping the day's actual zoned boundaries,
including overnight activities, intermediate lodging nights and 23/25-hour DST days.
Each boundary resolves its own calendar date's zoned start: if today's midnight is
skipped and the day starts at 01:00, tomorrow's boundary is still resolved from
tomorrow's date rather than carrying that 01:00 clock time forward.
Assigned wishlist places appear only under 「今天想去（未排時間）」; accepting a
day's suggested order refreshes the Today wishlist, its timezone and its snapshot.
Cards show existing type-specific details, full start/end times, explicit participant
sets, constraints and first-party notes; absent fields are omitted. Each endpoint
keeps its own local time; cross-zone card headings and personal current/next lines
identify the endpoint place and IANA zone rather than converting both ends into
the displayed day's zone. Personal current/next uses only the signed-in member's confirmed
participation and half-open time intervals (`start <= now < end`). Unconfirmed
participants are never promoted to the whole group. Overlaps stay in one column
and are labeled 「並行」, without inventing travel between adjacent group items.
Only reliable coordinates produce Maps links; transport directions use that
formal item's own endpoints. Every external URL sourced from provider or member
data is rendered as a link only after the shared client check accepts an absolute
HTTP or HTTPS URL; rejected values remain plain text. Missing locations stay
「位置待補充」. No persisted route observation is part of this formal read model,
so transportation is labeled unavailable rather than displaying generated route
estimates or stale live traffic.

Each successful, version-consistent read saves one localStorage snapshot per
account and trip: `{ schemaVersion: 6, accountId, fetchedAt, model }`. The model
contains trip ID/name/version, the current member ID, resolved day zones, item
IDs, untimed wishlist routing fields, place types, and allowlisted card fields. Participant
labels use display name, falling back to email, only for participants in the stored
formal items; it also retains whether each historical participant is known
to have been removed. Unused profile emails, invitations, change events, member
profiles, drafts, credentials, provider keys and unsaved inputs are never copied.
Compatible version-2/3/4/5 snapshots migrate strictly to version 6.
Missing endpoint references, participant-removal status, place types and legacy
wishlist routing facts remain `null`; migration never guesses them from another snapshot.
If persisting that upgrade fails, the validated in-memory model remains readable
and the original saved value is preserved. See the
[feature migration details](docs/engineering/place-details-and-photos.md#ui失敗與-today-snapshot).
Malformed, extra-field or incompatible snapshots are discarded. A valid snapshot
is also removed on read once it is more than 14 days old or after the complete
seventh day following the trip's final date, whichever comes first. Storage
failure is visible and does not prevent reading the online itinerary.

Browser-offline events or failed core API reads open a dedicated 「離線資料」
shell with snapshot time and an explicit warning that membership and newer edits
cannot be checked. Editable panels are absent there and the request boundary
refuses mutations; nothing is queued. Reconnect/retry validates the session and
trip membership again before replacing the snapshot. Every successful authorized
trip-list read also purges this account's snapshots for absent trips, including
unselected revoked trips. Core trip GETs returning 401/403/404 delete cached access;
an inaccessible bookmarked trip does not invalidate a valid session or hide other
authorized trips. Logout clears that account's snapshots, account-scoped filters,
onboarding state and in-memory itinerary. Offline logout also records a local
signed-out boolean so a surviving HttpOnly cookie cannot silently reopen private
data; a `storage` event applies that teardown to every open tab. A new magic-link
sign-in clears the marker. If the browser is offline or the logout request fails,
a separate pending marker stores that account's user ID and replays
`POST /api/logout` with `{ userId }` before later API work as soon as connectivity
returns. The signed-out screen warns while this server logout remains pending.
An online logout still sends immediately when localStorage is blocked or full.
The target is removed after a 204, or after `logout_target_mismatch` establishes
that a newer account owns the current cookie without signing that account out.
The account controls also offer 「登出所有裝置」, backed by
`POST /api/logout-everywhere`.
Online the action is 「重新同步」; the read-only shell offers
「重新連線並同步」.
A failed mutation while the browser remains online keeps its existing dialog,
input, error feedback and idempotency key for an explicit retry; it does not switch
to the offline shell. Provider-only failures likewise do not change this boundary.
Recovery revalidates immediately on `online`, focus, and becoming visible. While
the read-only shell is visible and `navigator.onLine` is true, a single-flight
read check also runs every two seconds: a service-worker offline reopen can
already report online and emit no new connectivity event when requests recover.
This fallback only retries authenticated reads, stops on recovery, and never
resubmits a mutation.

The production Vite build emits `/sw.js` from the built asset manifest and finalized
HTML content, so an HTML-only deployment also changes the worker/cache revision.
It registers at the application root and caches only the public HTML shell and
hashed built assets. Both `/api` and every `/api/*` request bypass all cache
handlers, including authenticated image requests. Activation deletes the legacy
`hk-trip-static-v12` and `hk-trip-images-v12` caches so private responses saved by
an older worker cannot survive the cutover. Offline root navigation uses the shell,
then the private read-only snapshot store. Development mode does not register a
worker. There are **no database migrations or new API endpoints**
for this issue; the shared zone resolver is the only new shared contract export.

Unit coverage includes different device/trip dates, DST and midnight boundaries
(including midnight gaps in Santiago and Havana),
multi-night lodging, pre/post-trip, cross-zone endpoint presentation, participant
identity/pending states, overlaps, gaps/completion and snapshot privacy/schema/account
isolation. Mounted-App HTTP-boundary regressions cover unselected revocation,
inaccessible bookmarks, delayed cross-trip Back/Forward, mounted-panel sync and
accepted day ordering. An isolated Vite-build/worker-runtime scenario verifies an
HTML-only deployment reaches offline reopening and API requests bypass the worker.
Real-device accessibility, actual external navigation destinations and the 2.5s 4G
performance target remain UNVERIFIED.

## Concurrent editing and live collaboration (Issue #27)

Saved field edits use the edited aggregate's `expectedVersion`, not a global
trip write lock/version supplied by the client. Two members can edit different
wishlist places independently. A stale edit returns `409` with
`error.code: "conflict"`, `currentVersion`, and `latestChange` (nullable;
`eventId`, `actorId`, `actorDisplayName`, `actorEmail`, `isOwn`, `changedAt`). Related legacy/wishlist
place identities, constraint changes to their item, and assignment changes to
their day retain the responsible event's attribution. A rejected edit changes
neither the aggregate nor its event history; an idempotent retry returns the
original result without adding an event.
Discovery brief creation uses `expectedVersion: null` to mean the aggregate was
absent. A competing creation returns the same structured `409`, not a validation
error or duplicate-key failure. Creation is serialized by the brief's identity,
without imposing a shared client-side Trip version on unrelated edits.

Open field editors retain their original version and unsaved input when a
notification refreshes the surrounding read model. Pristine planning editors
adopt newer saved values after a successful save or merge; dirty editors do not.
The zh-TW conflict panel
compares the original, freshly read current, and attempted values field by
field, with the latest actor/time. Changed fields appear first; identical fields
collapse into one count rather than repeating three values on a phone. Actor
labels use display name, then email, including removed members' past events.
Only typed enum fields receive translated values. Member-entered names, notes,
briefs, and free-form detail fields remain verbatim, even when their text equals
an enum key such as `walking`.
A change by the signed-in member is identified as an update in another window
or device. Members can accept the saved version, return to editing their preserved
input against the newly read version, or explicitly
reapply their **complete** input. There is no automatic field merge. Reapply
uses a new idempotency key, the freshly read version, and
`Conflict-Base-Version: <original version>` for audit only; normal membership,
lock, constraint, deletion, and version checks still run. Another intervening
edit can produce another conflict. An unavailable target cannot be reapplied.
Discovery brief text and clarification answers keep independent edit bases:
returning from one conflict cannot silently rebase the other input.
Reapply validation errors stay visible beside
the comparison panel.
Generation uses the current saved brief version even after a standalone answer
save.

Removed wishlist places disappear from the active read model. A dirty editor
may retain a separate, unavailable snapshot with its unsaved input, no active
vote/remove controls, and an explicit discard-and-close action. Pristine closed
editors are not retained. New Place/item dialogs use the latest creation
precondition without changing their input. A stale create refreshes that
precondition for an explicit retry; an uncertain network result retains the
same request/version/key so retrying cannot duplicate an already saved item.

Place assignment and order share a `TripDay` version.

- `POST /api/trips/:tripId/days/:dayId/route` returns an unsaved route draft and
  checks the day version before and after reading its inputs. A concurrent
  assignment or order change returns `409`.
- `PUT /api/trips/:tripId/days/:dayId/place-order` requires
  `{ orderedTripPlaceIds, expectedVersion }` and returns
  `{ orderedTripPlaceIds, version }`.
- `PUT /api/trips/:tripId/days/:dayId/arrangement` requires
  `{ orderedTripPlaceIds, expectedVersion }`; places omitted from the candidate
  return to 待安排 and eligible unassigned places join the day. Schedulers only.
- Order and assignment changes advance the day version. A stale suggested order
  remains unsaved and asks the member to regenerate and explicitly confirm it.

### Authenticated notifications and history

- `GET /api/trips/:tripId/version` returns `{ tripVersion, lastEventId }`.
  Here `tripVersion` is a strictly increasing **notification watermark**,
  not `TripDto.version` and never a mutation's `expectedVersion`.
- `GET /api/trips/:tripId/events` is authenticated SSE. `event: change` carries
  only `{ id, tripVersion, entityType, entityId, kind, summary }`, and the SSE
  `id` is the change-event UUID. No notes, booking details, contact information,
  coordinates, access tokens, or complete private objects are streamed.
  Resume with `Last-Event-ID` or the browser's `?after=<event UUID>` fallback.
  Cursors must belong to this trip. Membership is authorized on every poll; the
  session token and active membership are rechecked before each payload and
  15-second heartbeat, so revoked streams close without another event. One account
  may hold at most six event streams; an abort or stream completion releases its
  slot.
- There is one subscription for the selected trip. Notifications only trigger
  authorised read-model refetches and revision counters; mounted tab panels are
  not replaced. Reconnect backs off from 1 to 30 seconds. An authoritative
  60-second version check runs even while SSE appears connected, and
  focus/visibility/online checks recover changes immediately. Failed projection
  reads schedule a separate 1–30-second backoff refresh and are retried on focus
  even when the notification watermark has not advanced. A notification cursor is
  not treated as proof that every projection loaded. Trip changes and access
  revocation cancel outstanding retry timers. Every connection emits a comment
  immediately. Bun's idle timeout is 30 seconds; Caddy flushes streaming responses
  immediately.
- `GET /api/trips/:tripId/history?limit=30&before=<event UUID>` returns
  `{ events, nextCursor }`, newest first (limit 1–100). Events include actor
  identity/display name/email, creation time, type, target, safe summary, and nullable
  `reappliedFromVersion`. `targetName` resolves the current place name, item title
  or day date within this trip; removed/deleted targets show only their type, never
  an ID fragment. Reapply labels explicitly identify the version editing started
  from, not the current version. Emails appear only in authorized history/conflict
  reads, never in SSE payloads. Pagination uses committed event order rather than
  timestamps, so ties and new insertions cannot skip/duplicate older entries.
  A removed member's past attribution remains visible to current members.
  The old capped `TripSkeletonDto.events` projection has been removed.

All these reads require an active membership and are `no-store`. Streams,
errors and proxy configuration avoid logging private request bodies, cookies,
or raw private paths/query strings; application diagnostics retain safe event
types, IDs/results and correlation IDs.

### Database changes and verification

Expand-only migration `019_collaboration_events` adds ordered event cursors,
optional reapply audit versions, related aggregate IDs, and supporting indexes.
Its insert trigger locks the trip row `FOR NO KEY UPDATE` **before** allocating
the sequence value, preventing a later committed event from overtaking an
uncommitted earlier cursor. Sharing the trip writer's lock domain avoids the
advisory-lock/FK inversion; the mode remains compatible with older writers'
foreign-key `KEY SHARE` locks. Historical events are backfilled deterministically.
Existing insert shapes still work. `down` removes the trigger, sequence,
indexes and added metadata columns; the underlying event rows remain.

Expand-only `020_trip_day_versions` adds a defaulted positive day version and
triggers for window and assignment changes (including writes by an older
release). Transaction-local affected-day tracking associates subsequent
`recordEvent` entries with the changed days. `down` removes only those
triggers/functions and the day version; saved hours, assignments and orders
remain intact.

Verified through the real Bun HTTP server on an isolated test database:
four authenticated readers received the same metadata-only SSE event; stale
place and day writes were rejected without overwriting saved values; explicit
reapply was audited; history pagination and Last-Event-ID catch-up worked;
membership removal closed/refused the stream and history; and the real
15-second heartbeat reached the reader. API integration coverage also exercises
independent/same-aggregate races, idempotent replay, deleted/locked targets,
cross-trip/unauthenticated access and assignment-invalidated day orders.
The complete Chromium browser suite passed through an isolated stack using the
real Caddyfile after integrating #28 at `fbf46bd`: **28 passed**. It exercises all three conflict actions, mobile
input preservation, independent place edits, day conflicts, discovery-brief
creation conflicts, participant comparisons, focus recovery and SSE reconnect,
plus visible reapply errors, removed editor dismissal, failed-projection
recovery, and create-dialog version/idempotency regressions. API regressions
reproduce concurrent invite/day writes and a reorder during draft reading. A
deterministic queued
SSE test fails when per-event authorization is removed and passes with it
restored, proving that revocation between batch read and send releases no payload.
After the final review fixes, the tree passes typecheck, **242 unit tests**, **118 integration tests**
and the production build in `/i27` against `along_the_way_test27`. Browser tag `27`
also verifies standalone answer generation, actor email fallback, named/deleted
targets, reapply base-version wording, compact field comparisons, same-account
updates, and Today's live day-order/offline snapshot refresh. Real 390px/1440px
Chromium captures show the changed note first
and three unchanged fields collapsed, without horizontal phone overflow.
Mounted-App regressions fail before and pass after guarding pending navigation
from an old trip's live change/revocation and retaining failed mutation errors
during background reads. The raw SSE guard rejects an injected email and passes
with metadata-only notifications restored.
The final discovery and wishlist Chromium rerun passed **20 tests**, including a
conflict whose current note is `步行` but whose attempted and reapplied note is
`walking`. Rendered-component regressions fail before and pass after preserving
free text while still translating typed enums.
Production TLS/deployment and real-device behaviour remain **UNVERIFIED**;
these checks used only the isolated issue-27 stack.

The existing static site remains available at
<https://tzurae.github.io/along-the-way/>.
