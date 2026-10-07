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
docker compose up --detach --build --wait
```

Open `http://localhost`, request a sign-in link for the configured Owner, then
open the captured message at `http://localhost:8025`. A PostgreSQL-backed worker
delivers queued authentication and invitation email. The same magic-link,
session, Trip, membership, and invitation path is used outside local
development; Mailpit replaces only the SMTP destination.

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

Staging setup, HTTPS deployment, persistent data, and rollback are documented in
[`docs/operations/staging.md`](docs/operations/staging.md).

## Shared flights and lodging (Issue #74)

`POST /api/trips` requires `name`, `startDate`, `endDate`, ordered `countryCodes`
and `flights: { outbound, return }`. Each flight is:

```ts
{
  serviceNumber: string;
  carrier: string | null;
  departureAirport: { name: string; timeZone: string };
  arrivalAirport: { name: string; timeZone: string };
  departureLocalDateTime: string; // YYYY-MM-DDTHH:mm
  arrivalLocalDateTime: string;   // YYYY-MM-DDTHH:mm
  departureUtcOffset?: string | null; // e.g. "-04:00" for a repeated local hour
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
(`countryStopId: null`). Flight titles are service numbers. New travel items select
all active members explicitly at save time, not the `null` pending-confirmation party.
For repeated DST hours, supply the chosen UTC offset. Omitting an offset on PATCH
retains the current occurrence only when its local time and timezone are unchanged;
explicit `null` clears that choice and normal endpoint validation applies.

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

## AI discovery feedback and questions (Issue #66)

Discovery mutations require an `Idempotency-Key` and the current version:

- `POST /api/trips/:tripId/discovery/feedback` accepts only whole-trip
  `originalText`; a `proposalId` field is rejected with `400 validation_error`.
  Candidate cards no longer offer a targeted feedback form. Historical targeted
  records still display 「針對：X」 and reach the model labelled with that place.
  Feedback responses retain `proposalId`, `proposalName`, `interpretationEdited`,
  and `isOwn`; clients only offer pending-feedback actions when `isOwn` is true.
- `POST /api/trips/:tripId/discovery/feedback/:feedbackId/decision` accepts
  `expectedVersion`, `decision` (`confirm` or `reject`), and, when confirming,
  an optional complete `interpretation` containing `interests`, `exclusions`,
  nullable `pace` and `budget`, and `summary`. Supplying it replaces only the
  structured interpretation, marks it edited, and makes that member-corrected
  interpretation authoritative over conflicting original wording in later
  planning and research; `originalText` is immutable. Only the feedback author
  may confirm, edit, or reject it.
- `PUT /api/trips/:tripId/discovery/brief/questions` accepts
  `expectedVersion` and ordered `answers` entries `{ question, answer }`.
  `answer: null` explicitly means skipped and unknown. Saving answers increments
  the brief version even though its text is unchanged, so the next generation
  and its idempotent replay use one consistent answer set. Changing the brief
  text clears all earlier question answers.

`DiscoveryBriefDto.questionAnswers` reloads saved answers and skips. Planning
and research receive both forms: answered questions constrain the request,
while skipped questions remain unknown and must not be guessed or asked again.
Migration `014_discovery_feedback_answers` stores these answer records and the
edited-interpretation marker.

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
Run browser verification against a freshly seeded, disposable app database:
`owner@example.test` must exist and Mailpit must be reachable by the test process.
Integration fixtures must not be left in the browser database; a prior earlier
Trip otherwise changes which Trip the existing summary scenario opens on reload.

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
voted or not. Voting exists only while the trip has at least two active members
(`trip_members.removed_at is null`); with fewer, the vote endpoints return
`409 voting_unavailable` and neither the wishlist nor plan drafts use vote
order. Removed members' votes never count.

- `PUT /api/trips/:tripId/trip-places/:tripPlaceId/vote` returns `{ tripPlace }`.
- `PUT /api/trips/:tripId/discovery/proposals/:proposalId/vote` returns
  `{ discovery }`; only `pending` proposals accept votes.

Both require an `Idempotency-Key` and a body of `{ "voted": true }` or
`{ "voted": false }` (set-state, no `expectedVersion`). They always change the
signed-in member's own vote; a member ID in the body is ignored. A retry of a
stored request replays its original result.

Place and proposal DTOs carry `voters` (`memberUserId`, `memberEmail`,
`memberDisplayName`), `voteCount`, `ownVote` and `votingAvailable`. The
wishlist is ordered by vote count, ties keeping creation order; voted cards are
tinted and the top-voted cards (at least two votes) slightly more. AI proposal
order is unchanged. Accepting a proposal copies active members' votes to the
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
ordinary identity unarchives its existing row; travel-only identities still
return `409 travel_place`. Manual intake and the possible-duplicate/merge flow
are unchanged. AI acceptance continues to reuse an existing wishlist identity.

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

Removal, itinerary deletion, and discovery/read-time repair of an archived or
missing accepted place reopen all its accepted proposals to `pending`, clear
`decided_by`, `decided_at`, and `accepted_trip_place_id`, increment the proposal
version, and record `discovery.proposal_reopened`. The canonical proposal for a
provider identity is the newest proposal in the trip in **any status** (run
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

## Mobile Today and read-only offline trips (Issue #28)

「今天」 is the first trip tab and the default when an actual TripDay matches
the current instant in that day's IANA time zone; otherwise 「總覽」 remains
the default. `?trip=<id>&tab=today&day=YYYY-MM-DD` preserves the selected trip,
tab and valid day across reloads and browser history. Automatic corrections replace
the current history entry and wait for the destination trip's model. Other tabs
remain mounted; a successful Today sync publishes a separate read-refresh revision
so itinerary, lodging and recent changes update without a Today reload loop.

The shared `resolveDayTimeZone` contract preserves the planner's precedence:
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
formal item's own endpoints. Missing locations stay 「位置待補充」. No persisted
route observation is part of this formal read model, so transportation is labeled
unavailable rather than displaying generated route estimates or stale live traffic.

Each successful, version-consistent read saves one localStorage snapshot per
account and trip: `{ schemaVersion: 2, accountId, fetchedAt, model }`. The model
contains trip ID/name/version, the current member ID, resolved day zones, item
IDs, separate untimed wishlist names, and allowlisted card fields. Participant
labels use display name, falling back to email, only for participants in the stored
formal items; unused profile emails are not copied. Invitations, change events,
member profiles, drafts, credentials, provider keys and unsaved inputs are never copied.
Malformed, extra-field or incompatible snapshots are discarded. Storage failure
is visible and does not prevent reading the online itinerary.

Browser-offline events or failed core API reads open a dedicated 「離線資料」
shell with snapshot time and an explicit warning that membership and newer edits
cannot be checked. Editable panels are absent there and the request boundary
refuses mutations; nothing is queued. Reconnect/retry validates the session and
trip membership again before replacing the snapshot. Every successful authorized
trip-list read also purges this account's snapshots for absent trips, including
unselected revoked trips. Core trip GETs returning 401/403/404 delete cached access;
an inaccessible bookmarked trip does not invalidate a valid session or hide other
authorized trips. Logout clears that account's snapshots and in-memory itinerary.
Offline logout also records a local signed-out boolean so a surviving HttpOnly
cookie cannot silently reopen private data on reconnect; a new magic-link sign-in
clears that marker. It does not queue a remote logout. Online the action is
「重新同步」; the read-only shell offers 「重新連線並同步」.
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
hashed built assets, never `/api/*` or other responses. Offline root navigation
uses that shell, then the private read-only snapshot store. Development mode does
not register a worker. There are **no database migrations or new API endpoints**
for this issue; the shared zone resolver is the only new shared contract export.

Unit coverage includes different device/trip dates, DST and midnight boundaries
(including midnight gaps in Santiago and Havana),
multi-night lodging, pre/post-trip, cross-zone endpoint presentation, participant
identity/pending states, overlaps, gaps/completion and snapshot privacy/schema/account
isolation. Mounted-App HTTP-boundary regressions cover unselected revocation,
inaccessible bookmarks, delayed cross-trip Back/Forward, mounted-panel sync and
accepted day ordering. An isolated Vite-build/worker-runtime scenario verifies an
HTML-only deployment reaches offline reopening and API requests bypass the worker.
`apps/web/e2e/today.spec.ts` exercises the real API with disposable four-member trips,
`page.clock`, phone/desktop overlaps, cross-zone flights, a midnight-crossing activity,
day URL reload/Back/Forward, a California trip, `context.setOffline`, formal-version
and mounted-panel refresh, unselected membership removal, inaccessible bookmarks
and offline logout. Run that spec against the **production** web build so complete
offline reopening also exercises the service worker.
The Chromium spec verifies single-column phone/desktop overlaps and offline
reopening/recovery through the production shell. Real-device accessibility,
actual external navigation destinations and the 2.5s 4G performance target
remain UNVERIFIED.

The existing static site remains available at
<https://tzurae.github.io/along-the-way/>.
