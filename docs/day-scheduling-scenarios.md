# Day scheduling with travel modes — spec and scenarios

The spec and scenarios below were written before the answers. Two reviewers derived every answer
by hand from this document alone, without reading code, and agreed on all fifteen; the
implementation matches them. `apps/api/test/day-scenarios.test.ts` encodes the agreed answers
(plus S16, added afterwards for the "NO FIT" outcome). `apps/api/test/day-timetable.property.test.ts`
checks the general invariants over generated days.

## Spec (product rules)

### The day
- A day has a window: start time S and end time E. Nothing may be scheduled before S or end after E.
- No lodging in any scenario: the day begins at the first placed place at S (there is no travel into the first placed place).
- The day has an ordered list of places. Each place has a stay (minutes) and opening hours: either "unknown" (treat as always open) or one or more open intervals on that day.

### Travel modes
A leg is the travel from one placed place to the next placed place. The leg's mode is the override set on the place being *arrived at*, if any; otherwise the day's mode.

Each pair of places has: walk minutes, transit minutes (or "none" = no transit), drive minutes.

- 大眾運輸 (transit): if walk ≤ 15 minutes → walk; otherwise → transit minutes; if transit is "none" → the leg's time is unknown (never substitute a long walk).
- 盡量走路 (walk) with the day's walk limit L: if walk ≤ L → walk; otherwise transit; if transit is "none" → unknown.
- 計程車 (taxi): drive minutes + 5 (waiting for the cab).

### Placing places
Places are tried in list order. For each place:
- Its arrival = the end of the previous *placed* place + the leg time (the first placed place arrives at S with no leg).
- If the leg time is unknown, the place cannot be placed.
- It starts at its arrival, or later at the start of an opening interval if it arrives before one opens; the whole stay must fit inside one open interval and must end by E.
- If it cannot be placed, it is "unscheduled" (skipped). The next place is tried from the end of the last *placed* place (an unscheduled place takes no time and is not travelled through).

### Removing a placed place P (「這天不去」 or dragging it out to the pool)
The new list is: the placed places in their current order without P, followed by the currently unscheduled places in their current order. Then everything is placed again with the rules above.

### Adding a place Q at a chosen position (dragging it in from the pool)
Let "placed before" be the set of places that are placed in the current list (without Q).
1. Place the list with Q inserted at that position, using the current modes. If Q is placed and every "placed before" place is still placed → outcome **FITS**; the new list is accepted.
2. Otherwise try taxi for the legs touching Q, in this order, stopping at the first that works:
   (a) taxi on the leg into Q only;
   (b) taxi on the leg out of Q only — the leg out of Q is the leg arriving at the first place after Q in the list that is in "placed before";
   (c) taxi on both legs.
   "Works" means Q is placed and every "placed before" place is still placed. If one works → outcome **TAXI PROMPT (a/b/c)**; if the user accepts, those legs get taxi overrides and that schedule is the new list. (If Q has no next placed place, only (a) is tried.)
3. If none works:
   - If, in step 1, Q was placed but some "placed before" place became unscheduled → outcome **SWAP PROMPT** naming the pushed-out place(s). (The user can decline; nothing changes.)
   - Otherwise → outcome **NO FIT**; nothing changes.

## Scenarios

Answer format per scenario: for every operation, give the outcome (FITS / TAXI PROMPT a|b|c / SWAP PROMPT [names] / NO FIT / n/a for removals), and after the final operation (applying FITS automatically, and ACCEPTING any taxi prompt unless the scenario says otherwise; declining swap prompts) give the final schedule: each placed place with start–end (HH:MM), and the list of unscheduled places. If a scenario is ambiguous under the spec, say exactly what is ambiguous and give the answer under each reading.

Travel tables give `walk / transit / drive` minutes for each unordered pair (same both directions). A pair not listed is never travelled in that scenario.

### S1 — transit day, walk vs transit
Window 09:00–18:00, day mode transit. List: A, B, C. Stays 60 each, hours unknown.
Pairs: A–B 10 / 20 / 6; B–C 30 / 12 / 8.
Operation: none (just schedule).

### S2 — walk day with limit 30
Same as S1 but day mode walk, L = 30.

### S3 — transit missing beyond walking distance
Window 09:00–18:00, transit day. List: A, B, C, D. Stays 60, hours unknown.
Pairs: A–B 10 / 20 / 6; B–C 30 / none / 8; B–D 5 / none / 4; C–D 20 / 10 / 6.
Operation: none.

### S4 — per-leg taxi override
Same as S1 but C has override taxi.

### S5 — waiting for opening
Window 09:00–18:00, transit day. List: A, B, C. Stays 60. A hours unknown; B open 11:00–17:00; C hours unknown.
Pairs: A–B 10 / 20 / 6; B–C 5 / none / 3.
Operation: none.

### S6 — closes too early
Window 09:00–18:00, transit day. List: A, B, C. Stays 60. B open 09:00–10:30 only; A, C unknown.
Pairs: A–B 10 / 20 / 6; A–C 12 / 25 / 7; B–C 5 / none / 3.
Operation: none.

### S7 — add that fits
Window 09:00–13:00, transit day. List: A, B. Stays 60, hours unknown.
Pairs: A–B 10 / 20 / 6; B–C 40 / 15 / 10.
Operation: add C at the end.

### S8 — add needing taxi on the leg into it only
Window 09:00–12:22, transit day. List: A, B. Stays 60, hours unknown.
Pairs: A–B 50 / 40 / 15; A–Q 50 / 40 / 15; Q–B 2 / none / 4.
Operation: add Q between A and B.

### S9 — add needing taxi on both legs
Window 09:00–12:40, transit day. List: A, B. Stays 60, hours unknown.
Pairs: A–B 40 / 20 / 10; A–Q 60 / 30 / 10; Q–B 60 / 30 / 10.
Operation: add Q between A and B.

### S10 — add impossible even by taxi
Window 09:00–12:00, transit day. List: A, B. Stays 60, hours unknown.
Pairs: A–B 10 / 20 / 6; A–Q 60 / 30 / 20; Q–B 60 / 30 / 20.
Operation: add Q between A and B.

### S11 — add that pushes another out
Window 09:00–12:00, transit day. List: A, B. Stays: A 60, B 60, Q 60. Hours unknown.
Pairs: A–B 5 / none / 3; A–Q 5 / none / 3; Q–B 5 / none / 3.
Operation: add Q between A and B.

### S12 — removal never pushes a placed place out
Window 09:00–12:00, transit day. List: W, X, Y. Stays: W 30, X 160, Y 60. Hours unknown.
Pairs (all at the same spot): W–X 0 / none / 0; W–Y 0 / none / 0; X–Y 0 / none / 0.
Operations: (1) schedule; (2) remove W.

### S13 — remove, then add back elsewhere
Window 09:00–15:00, transit day. List: A, B, C. Stays 60, hours unknown.
Pairs: A–B 10 / 20 / 6; B–C 10 / 20 / 6; A–C 30 / 14 / 8.
Operations: (1) remove B; (2) add B at the end (after C).

### S14 — taxi day
Window 09:00–18:00, day mode taxi. List: A, B, C. Stays 60, hours unknown.
Pairs: A–B 10 / 20 / 6; B–C 30 / 12 / 8.
Operation: none.

### S15 — per-leg walk override on a transit day
Window 09:00–18:00, day mode transit; the day's walk limit setting L = 30 (left over from when the day was a walk day). List: A, B. B has override walk. Stays 60, hours unknown.
Pairs: A–B 25 / 12 / 7.
Operation: none.

## Agreed answers

| Scenario | Outcomes | Final schedule | Unscheduled |
| --- | --- | --- | --- |
| S1 | — | A 09:00–10:00, B 10:10–11:10, C 11:22–12:22 | — |
| S2 | — | A 09:00–10:00, B 10:10–11:10, C 11:40–12:40 | — |
| S3 | — | A 09:00–10:00, B 10:10–11:10, D 11:15–12:15 | C |
| S4 | — | A 09:00–10:00, B 10:10–11:10, C 11:23–12:23 | — |
| S5 | — | A 09:00–10:00, B 11:00–12:00, C 12:05–13:05 | — |
| S6 | — | A 09:00–10:00, C 10:12–11:12 | B |
| S7 | FITS | A 09:00–10:00, B 10:10–11:10, C 11:25–12:25 | — |
| S8 | TAXI PROMPT a | A 09:00–10:00, Q 10:20–11:20, B 11:22–12:22 | — |
| S9 | TAXI PROMPT c | A 09:00–10:00, Q 10:15–11:15, B 11:30–12:30 | — |
| S10 | SWAP PROMPT [B] (declined) | A 09:00–10:00, B 10:10–11:10 | — |
| S11 | SWAP PROMPT [B] (declined) | A 09:00–10:00, B 10:05–11:05 | — |
| S12 | n/a | Y 09:00–10:00 | X |
| S13 | n/a, FITS | A 09:00–10:00, C 10:14–11:14, B 11:24–12:24 | — |
| S14 | — | A 09:00–10:00, B 10:11–11:11, C 11:24–12:24 | — |
| S15 | — | A 09:00–10:00, B 10:25–11:25 | — |

Notes from the derivation: S10's title says "impossible even by taxi", but because Q itself is
placed (only B is pushed out) the rules give a swap prompt, not NO FIT; both reviewers read it
that way. "Unscheduled" above lists places in the day's list that could not be placed; a place
left in the pool after a declined add is not in the day's list.

## Open questions (not decided; current behavior described)

1. **"If taxi fails, no other way can succeed" is not always true.** The property tests found
   days where taxi for the two legs does not fit but another way does:
   - on a 計程車 day every leg is a cab (drive + 5), so two places 200 m apart take ~9 minutes
     where walking takes 3;
   - a leg a member set by hand (say 盡量走路) can be slower than the day's way;
   - on a 盡量走路 day with a low walk limit, a short leg with no transit is unknown, where a
     大眾運輸 day would simply walk it.
   Current behavior: the drop flow tries only each leg's own way and taxi. Options: keep it;
   try every way per leg and offer the fastest; or let 計程車 days walk legs under some minutes.
2. **A per-leg 盡量走路 override on a 大眾運輸 or 計程車 day uses the day's stored walk limit**
   (S15), which the dialog only shows while the day itself is 盡量走路. Options: keep it; show the
   limit whenever any leg walks; or use 15 minutes for overrides.
3. **The leg back to the lodging always uses the day's way.** Taxi fallback cannot change it, so
   a place that only fits with a taxi ride home is reported as not fitting.
