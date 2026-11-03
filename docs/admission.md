# Admission management

Admission management turns a booking of an entrance ticket into passes that are checked at the entrance of a facility, such as a public pool: season, day, quota, family and group tickets, and time-limited access for a group of people. German terms in the [glossary](../GLOSSARY.md#einlass).

**State of this branch:** the pure core and the scheduler. Storage, device access, the check route and the issuance from the booking lifecycle build on it and follow (see [Next steps](#next-steps)). Nothing here is wired into the running API yet; existing booking, approval and cancellation paths are untouched.

## Where it sits

```
 Booking (bookings)                 the place of payment, cancellation and proof, unchanged
   │  lifecycle adapter "admission" (planned): issue on admit/confirm/pay,
   │  void on cancel/reject/acceptWithdrawal, restore on reinstate
   ▼
 Pass (one per person)              terms snapshot · code hash · projection
   │  appends to
   ▼
 Usage log                          entries, exits, resets, corrections with account and reason

 Device ── POST /api/:tenant/admission/checks (planned, device key, bound to one facility)
   └─► check service: read code ─► verify tag ─► look up pass ─► decide() ─► conditional write
```

| Module                                    | Responsibility                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `services/admission/admission-terms.js`   | Admission definition of a tariff, its validation, the snapshot a pass keeps, the German rule preview (Pos. 3.6) |
| `services/admission/admission-code.js`    | Access identifier, check symbol, signed QR payload, lookup hash, reading a scan or typed text                   |
| `services/admission/admission-state.js`   | Usage events, projection, replay, computed state, corrections allowed per state                                 |
| `services/admission/admission-check.js`   | The six steps of the check, result, reason, notices, the one effect                                             |
| `services/admission/admission-reset.js`   | Daily reset and maximum stay as a plan for the scheduled job                                                    |
| `services/admission/admission-reasons.js` | Vocabulary and German texts of results, reasons, notices, void causes                                           |
| `services/scheduler/`                     | Recurring jobs with lease, catch-up, retry and status, shared by all instances                                  |

All admission modules are pure functions over plain objects; they read no clock, database or environment. That keeps the rules the entrance depends on testable on their own and lets the storage layer change without touching them.

## Tariff definition

A tariff is a bookable of type `ticket` under the facility. Its definition, at `bookable.admission`:

```js
{
  validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
  //      or { type: "relative", months: 12 } | { type: "relative", days: 1 }
  //      or { type: "booking" }  (the booked period, e.g. a day ticket)
  usage: { type: "quota", quota: 10 }, // or { type: "single" } | { type: "unlimited" }
  lockMinutes: 180,
  personal: { required: true, photo: true },
  bundle: [{ label: "Erwachsene", count: 2 }, { label: "Kinder", count: 3 }],
  capacityCheck: "entry", // or "booking" (default) | "none"
}
```

`problemsOf` names what is wrong before a tariff is saved; `describe` shows the administration in whole sentences what the tariff issues and what follows at the entrance. At issuance `snapshotTerms` copies the definition into the pass, so a pass keeps the terms of its purchase (Pos. 2.2). A fixed window covers its last day in the facility's time zone; a relative one runs from the issuance by calendar, across changes of summer time.

## Access identifier and QR payload

|              |                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifier   | 16 symbols, printed `7KQ2-M9XD-4RTB-H3WA`: 15 from `crypto.randomInt` (73 bits) and a check symbol                                                                                                       |
| Alphabet     | `0-9 A-X` without `I L O U` (Crockford) and without `Y Z`, which keyboard-wedge scanners swap between QWERTY and QWERTZ; on input `I L` read as `1`, `O` as `0`                                          |
| Check symbol | Luhn mod 30: catches every single wrong symbol and every swap of neighbours except `0`/`X`, so a typo is answered without a lookup                                                                       |
| QR payload   | `BLT1.<identifier>.<tag>`, tag = 16 symbols (78 bits) of HMAC-SHA-256 over tenant and identifier under a key derived per tenant from `ADMISSION_CODE_SECRET`; QR alphanumeric mode, version 3 at level Q |
| Storage      | `sha256(tenantId:identifier)` as unique lookup key; the identifier itself only encrypted, for the re-delivery of a lost ticket (Pos. 5.3)                                                                |
| Not a ticket | The QR code of the confirmation mail (public status page) and an eight-symbol booking number are recognised and answered as such                                                                         |

A reissued pass gets a new identifier; the old one is kept as a retired hash and answered as replaced, as access points do with `previousScanCodes`.

## State model

The usage log is the source of truth, the projection is what it adds up to and is stored with the pass for a one-document read, the state is what the projection means at a moment. The state is computed, never stored.

| State      | LV term          | Holds when (first match wins)                                                       |
| ---------- | ---------------- | ----------------------------------------------------------------------------------- |
| `void`     | ungültig         | voided: booking cancelled, rejected or withdrawn, or by the administration          |
| `blocked`  | gesperrt         | blocked by the administration                                                       |
| `expired`  | abgelaufen       | now ≥ end of validity                                                               |
| `present`  | derzeit anwesend | open presence that began in the current business day and is within the maximum stay |
| `consumed` | verbraucht       | single entry used; quota at zero from the business day after its last day           |
| `absent`   | nicht anwesend   | entered before, usable                                                              |
| `issued`   | ausgestellt      | never entered                                                                       |

A quota pass at zero stays `absent` on the day of its last use, because a re-entry that day uses no quota (Pos. 3.3).

| Usage event         | Written by                | Effect on the projection                                                   |
| ------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `entry`             | device                    | opens the presence, marks the business day used, counts quota once per day |
| `exit`              | device                    | closes the presence                                                        |
| `auto_exit`         | scheduler                 | closes a presence beyond the maximum stay                                  |
| `day_reset`         | scheduler                 | closes a presence of an earlier business day                               |
| `reset_presence`    | administration            | closes a presence by hand                                                  |
| `undo_entry`        | administration            | takes an entry back: day, presence and lock period return (replay)         |
| `block` / `unblock` | administration            | blocks, unblocks                                                           |
| `void` / `restore`  | booking or administration | voids, restores                                                            |
| `reissue`           | administration            | new identifier for the same pass                                           |

Corrections by the administration need the account and a reason (`problemsOfEvent`), and `correctionsOf` lists the ones a state allows. A void that follows the booking is undone through the booking, never by hand.

## The check

`decide()` evaluates the six steps in this order; the first refusing step ends the check and names its reason. Only a granted entry or an exit has an effect, written by the caller with a conditional update so that two devices cannot both enter the same pass.

| Step          | Question                                                  | Reasons (German text for the staff)                                                                      |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1 Code        | readable, issued here, known, this facility?              | `code_unreadable`, `not_a_ticket`, `code_not_genuine`, `code_unknown`, `code_replaced`, `other_facility` |
| 2 Validity    | not void, not blocked, within validity?                   | `voided` „Ungültig: Buchung storniert“, `blocked` „Gesperrt: {note}“, `not_yet_valid`, `expired`         |
| 3 Usage       | single entry unused, quota left or today already counted? | `single_entry_used`, `quota_exhausted`                                                                   |
| 4 Presence    | not checked in without exit?                              | `already_present` „Bereits eingecheckt seit 09:15, kein Austritt erfasst“                                |
| 5 Lock period | over since the last entry?                                | `lock_period` „Erneuter Eintritt ab 11:30 möglich“                                                       |
| 6 Capacity    | facility not full, if the tariff checks at entry?         | `capacity_reached`                                                                                       |

Results: `granted`, `granted_with_notice`, `denied`; an exit scan answers `exited` or `not_present`. Notices tell the staff what was recorded and never act on it (Pos. 5.5): re-entry without quota, last quota day, compare the person, repeated refused attempts, unusually many entries in a day (thresholds per facility).

## Business day, daily reset, maximum stay

A business day runs from the facility's reset time to the next one (`resetTime`, default `03:00`, time zone of the facility), so a visit past midnight is one day. A presence counts only within its business day and the maximum stay. The check therefore never depends on the reset having run: a guest who left without scanning is let in the next day even if the scheduler was down.

The reset job runs every few minutes. `planReset` names the presences to close: `day_reset` for a presence of an earlier business day, `auto_exit` beyond the maximum stay, whichever ended it first, each with `closedAt`. A second run finds nothing, a run after days without one catches up in one go.

## Scheduler

`JobRunner` runs registered jobs (`name`, `everyMs`, idempotent `run`) and keeps their state in a store shared by all instances (`MongoJobStore`, collection `jobstates`; `MemoryJobStore` for tests).

- A run takes a lease with one conditional update; another instance skips the job; a lease of a crashed instance runs out.
- A job due while no instance ran runs once at the next tick and gets `dueAt`, the time it was first due.
- A failed run is retried after 30 s, doubling up to the interval; `pendingSince` keeps the original due time.
- `status()` reports per job last run, last success, last error, failures and `overdue` (no success for three intervals); failures and catch-ups are logged.

## Next steps

1. Storage: `AdmissionPass` (tenant, facility, tariff, booking, ticket, code hash, retired hashes, encrypted identifier, terms, projection, version), `AdmissionEvent` (usage log), `AdmissionCheck` (check log incl. refusals, idempotent by `scanId`), `AdmissionDevice`.
2. Device access: `Authorization: Device <key>`, key stored as hash, bound to one facility, rate limited with `RateLimiter`, blockable and renewable; route `POST /api/:tenant/admission/checks` marked `tokenAuthorized()`.
3. Issuance as lifecycle adapter `admission` with the failure policy of the other adapters.
4. Roles: an admission-only right next to the six existing groups; administration views and corrections; check UI.
5. Ticket PDF per pass on the existing PDF service, with a template per tenant.

## Tests

`tests/admission-*.test.js` and `tests/scheduler-job-runner.test.js`: every step and its reason, the order of the steps, quota per business day, re-entry, lock period, the end of presence without reset, the states and their precedence, replay with undone entries, the code's error detection, the QR size, the reset plan and the scheduler's lease, catch-up and retry.
