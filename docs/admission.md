# Admission management

Admission management turns a booking of an entrance ticket into passes that are checked at the entrance of a facility, such as a public pool: season, day, quota, family and group tickets, and time-limited access for a group of people. German terms in the [glossary](../GLOSSARY.md#einlass).

**State of this branch:** the pure core, the scheduler, the storage in MongoDB, the check service, device access and the check route `POST /api/:tenant/admission/checks`. The route is mounted, but no device can be registered yet, so it answers `401` to every caller. The registration of devices by the administration, the reset job at startup and the issuance from the booking lifecycle follow (see [Next steps](#next-steps)). Existing booking, approval and cancellation paths are untouched.

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

 Device ── POST /api/:tenant/admission/checks (device key, bound to one facility)
   └─► check service: reserve scan ─► read code ─► verify tag ─► look up pass
                      ─► catch up ─► decide() ─► append to usage log ─► answer
```

| Module                                          | Responsibility                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `services/admission/admission-terms.js`         | Admission definition of a tariff, its validation, the snapshot a pass keeps, the German rule preview (Pos. 3.6) |
| `services/admission/admission-code.js`          | Access identifier, check symbol, signed QR payload, lookup hash, reading a scan or typed text                   |
| `services/admission/admission-state.js`         | Usage events, projection, replay, computed state, corrections allowed per state                                 |
| `services/admission/admission-check.js`         | The six steps of the check, result, reason, notices, the one effect                                             |
| `services/admission/admission-reset.js`         | Daily reset and maximum stay as a plan for the scheduled job                                                    |
| `services/admission/admission-reasons.js`       | Vocabulary and German texts of results, reasons, notices, void causes                                           |
| `services/admission/admission-store.js`         | Passes, usage log, check log, devices, facility settings: MongoDB for the API, in memory for the tests          |
| `services/admission/admission-check-service.js` | The check of one scan: idempotent by `scanId`, one entry per pass under concurrent scans, check log             |
| `services/admission/admission-devices.js`       | Device keys, the device middleware (`Authorization: Device <key>`), block and renew                             |
| `platform/api/routes/admission.routes.js`       | `POST /checks` under `/api/:tenant/admission`                                                                   |
| `services/scheduler/`                           | Recurring jobs with lease, catch-up, retry and status, shared by all instances                                  |

The core modules (terms, code, state, check, reset, reasons) are pure functions over plain objects; they read no clock, database or environment. That keeps the rules the entrance depends on testable on their own. The store, the check service and the device access are the layer around them; the check service gets clock and ids injected, so its tests run on a fixed clock.

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
| Identifier   | 16 symbols, printed `7KQ2-M9XD-4RTB-H3WS`: 15 from `crypto.randomInt` (73 bits) and a check symbol                                                                                                       |
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

## Storage

| Collection            | Holds                                                                                                                                           | Unique                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `admissionpasses`     | Pass: tenant, facility, tariff, booking, position, label, holder, code hash, retired hashes, encrypted identifier, terms, projection, `version` | `tenantId+id`, `tenantId+codeHash` |
| `admissionevents`     | Usage log: one event per position `seq` of a pass, with type, time, business day and actor                                                      | `tenantId+passId+seq`              |
| `admissionchecks`     | Check log: every scan with device, direction, result, step, reason and the answer it got                                                        | `tenantId+scanId`                  |
| `admissiondevices`    | Devices: facility, name, key hash, status, created, renewed, last seen                                                                          | `tenantId+id`, `keyHash`           |
| `admissionfacilities` | Admission settings of a facility: reset time, time zone, maximum stay, exit scan, notice thresholds                                             | `tenantId+facilityId`              |

The capacity is the `amount` of the facility's bookable; a facility without admission settings answers `404 admission_facility_not_found`.

The usage log is the lock. An event is appended at position `version + 1` of its pass; of two devices that scan the same pass at the same moment only one can write that position, the other gets the duplicate key, reads the pass again and now sees it present. The projection on the pass follows in a second write, conditional on `version`. A process that dies between the two writes leaves the projection one event behind; the next check applies the events after `version` (or replays the whole log after an `undo_entry`) before it decides.

## Check API

`POST /api/:tenant/admission/checks` with `Authorization: Device <key>`:

```json
{
  "code": "BLT1.7KQ2M9XD4RTBH3WS.…",
  "scanId": "gate-1-000183",
  "direction": "entry"
}
```

`code` is what the scanner read or the staff typed (up to 256 characters), `direction` is `entry` (default) or `exit`, `scanId` (1 to 64 of `A-Z a-z 0-9 _ -`) is the device's id of the scan. The answer, `200`:

```json
{
  "scanId": "gate-1-000183",
  "result": "denied",
  "step": 4,
  "reason": "already_present",
  "message": "Bereits eingecheckt seit 09:15, kein Austritt erfasst",
  "notices": [],
  "pass": {
    "id": "…",
    "label": "Saisonkarte · Erwachsene",
    "holder": null,
    "state": "present",
    "validUntil": 1821045600000,
    "quotaLeft": null
  }
}
```

It carries no booking, payment or contact data. A refusal is a `200` with `result: denied`; error codes are for requests that cannot be checked:

| Status | Code                                                   | When                                                                 |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------- |
| 400    | `invalid_code`, `invalid_scan_id`, `invalid_direction` | malformed request                                                    |
| 401    | `device_key_missing`, `device_unknown`                 | no device key, or none of this tenant                                |
| 403    | `device_blocked`                                       | device blocked by the administration                                 |
| 404    | `admission_facility_not_found`                         | the device's facility has no admission settings                      |
| 409    | `scan_in_progress`                                     | the same `scanId` is still being checked (younger than 10 s): retry  |
| 409    | `admission_check_contended`                            | three attempts in a row lost the race for the pass: retry            |
| 429    | `too_many_checks`                                      | more than 120 checks per minute from one device, with `Retry-After`  |
| 503    | `admission_not_configured`                             | the instance has no `ADMISSION_CODE_SECRET` (at least 32 characters) |

The same `scanId` sent again gets the first answer and enters nothing twice; a first attempt that died under way (pending for 10 s or more) is checked again under the same `scanId`.

## Device access

A device is registered for one facility and gets a key `adm_` plus 32 random bytes (base64url), shown once; the platform keeps only its SHA-256. The key is no session: it opens nothing but the check of its facility, and only for its own tenant. A device can be blocked (`403`) or given a new key, which ends the old one, each on its own. Every check counts against the device's rate limit (`RATE_LIMIT_ADMISSION_CHECKS_PER_DEVICE`, default 120 per minute). The device's last contact is written at most once a minute.

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

1. Administration routes for devices (register, block, renew) and facility settings; the reset job registered with the scheduler at startup.
2. Issuance as lifecycle adapter `admission` with the failure policy of the other adapters.
3. Roles: an admission-only right next to the six existing groups; administration views and corrections; check UI.
4. Ticket PDF per pass on the existing PDF service, with a template per tenant.

## Tests

`tests/admission-*.test.js` and `tests/scheduler-job-runner.test.js`: every step and its reason, the order of the steps, quota per business day, re-entry, lock period, the end of presence without reset, the states and their precedence, replay with undone entries, the code's error detection, the QR size, the reset plan and the scheduler's lease, catch-up and retry. The check service: a scan sent twice, a scan under way, two devices at the same moment, a projection caught up from the log, exit, typed identifiers, forged, replaced and unknown codes, repeated attempts, capacity at entry, malformed requests and a missing secret. Device access over HTTP with the real error handler, and the filters the MongoDB store sends. The route appears in the authorization snapshot with `401` for every principal.
