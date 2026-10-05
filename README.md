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

## Activity participants (Issue #21)

This slice of [Issue #21](https://github.com/tzurae/along-the-way/issues/21)
connects explicit participant selection, transactional persistence, reload, and
daily cards. It does not implement automatic planning, participant columns, or
the personal current/next and offline features of Issue #28.

- `TripMemberDto.id` is the stable membership UUID. `userId` remains the account
  identity used for authorization and membership removal; the two are not aliases.
- Create and update item requests require `participantMemberIds`: `null` means
  pending confirmation; an explicit collection must be nonempty, duplicate-free,
  and contain membership IDs from this Trip. Nothing defaults to the whole roster.
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

The existing static site remains available at
<https://tzurae.github.io/along-the-way/>.
