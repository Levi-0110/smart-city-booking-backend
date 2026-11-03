const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  snapshotTerms,
} = require("../src/commons/services/admission/admission-terms");
const {
  ADMISSION_STATES: S,
  USAGE_EVENTS: E,
  businessDayOf,
  emptyProjection,
  applyEvent,
  replay,
  isPresent,
  stateOf,
  correctionsOf,
  problemsOfEvent,
} = require("../src/commons/services/admission/admission-state");
const {
  VOID_CAUSES,
} = require("../src/commons/services/admission/admission-reasons");

const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const FACILITY = Object.freeze({
  id: "freibad",
  resetTime: "03:00",
  zone: ZONE,
});
const STAFF = Object.freeze({ source: "administration", userId: "staff-1" });

const termsOf = (usage, extra = {}) =>
  snapshotTerms(
    {
      validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
      usage,
      ...extra,
    },
    { issuedAt: at("2027-05-01T09:00") },
  );
const UNLIMITED = termsOf({ type: "unlimited" });
const SINGLE = termsOf({ type: "single" });
const QUOTA = termsOf({ type: "quota", quota: 2 });

let seq = 0;
const event = (type, iso, extra = {}) => ({
  id: `e${++seq}`,
  type,
  at: at(iso),
  ...extra,
});
const entry = (iso) =>
  event(E.ENTRY, iso, { day: businessDayOf(at(iso), FACILITY) });
const exit = (iso) => event(E.EXIT, iso);

const stateAt = (events, terms, iso, facility = FACILITY) =>
  stateOf(replay(events, terms), terms, facility, at(iso));

describe("admission state", () => {
  describe("business day", () => {
    it("starts at the reset time, not at midnight", () => {
      expect(businessDayOf(at("2027-07-01T02:30"), FACILITY)).to.equal(
        "2027-06-30",
      );
      expect(businessDayOf(at("2027-07-01T03:00"), FACILITY)).to.equal(
        "2027-07-01",
      );
      expect(businessDayOf(at("2027-07-01T23:59"), FACILITY)).to.equal(
        "2027-07-01",
      );
    });

    it("holds across the changes to and from summer time", () => {
      expect(businessDayOf(at("2027-03-28T01:30"), FACILITY)).to.equal(
        "2027-03-27",
      );
      expect(businessDayOf(at("2027-03-28T03:30"), FACILITY)).to.equal(
        "2027-03-28",
      );
      expect(businessDayOf(at("2027-10-31T02:30"), FACILITY)).to.equal(
        "2027-10-30",
      );
      expect(businessDayOf(at("2027-10-31T03:30"), FACILITY)).to.equal(
        "2027-10-31",
      );
    });
  });

  describe("projection", () => {
    it("counts a day of quota once, however often the pass enters that day", () => {
      const p = replay(
        [
          entry("2027-07-01T10:00"),
          exit("2027-07-01T11:00"),
          entry("2027-07-01T15:00"),
        ],
        QUOTA,
      );
      expect(p.usedDays).to.deep.equal(["2027-07-01"]);
      expect(p.quotaLeft).to.equal(1);
      expect(p.entryCount).to.equal(2);
      expect(p.dayEntries).to.deep.equal({ day: "2027-07-01", count: 2 });
    });

    it("counts the next day again", () => {
      const p = replay(
        [
          entry("2027-07-01T10:00"),
          exit("2027-07-01T11:00"),
          entry("2027-07-02T10:00"),
        ],
        QUOTA,
      );
      expect(p.usedDays).to.deep.equal(["2027-07-01", "2027-07-02"]);
      expect(p.quotaLeft).to.equal(0);
    });

    it("gives day, presence and lock period back when an entry is undone", () => {
      const first = entry("2027-07-01T10:00");
      const second = entry("2027-07-02T10:00");
      const log = [
        first,
        exit("2027-07-01T12:00"),
        second,
        event(E.UNDO_ENTRY, "2027-07-02T10:05", {
          entryId: second.id,
          actor: STAFF,
          note: "Doppelt gescannt",
        }),
      ];
      const p = replay(log, QUOTA);
      expect(p.usedDays).to.deep.equal(["2027-07-01"]);
      expect(p.quotaLeft).to.equal(1);
      expect(p.presentSince).to.equal(null);
      expect(p.lastEntryAt).to.equal(first.at);
    });

    it("rebuilds the same projection from the log as step by step", () => {
      const log = [
        entry("2027-07-01T10:00"),
        exit("2027-07-01T11:00"),
        event(E.BLOCK, "2027-07-01T12:00", { actor: STAFF, note: "Prüfen" }),
        event(E.UNBLOCK, "2027-07-01T12:30", { actor: STAFF, note: "Geklärt" }),
        entry("2027-07-02T10:00"),
        event(E.DAY_RESET, "2027-07-03T03:00"),
      ];
      const stepwise = log.reduce(
        (p, e) => applyEvent(p, e, QUOTA),
        emptyProjection(QUOTA),
      );
      expect(replay(log, QUOTA)).to.deep.equal(stepwise);
    });

    it("leaves an undo to the replay", () => {
      expect(() =>
        applyEvent(
          emptyProjection(QUOTA),
          event(E.UNDO_ENTRY, "2027-07-01T10:00"),
          QUOTA,
        ),
      ).to.throw(/replay/);
    });
  });

  describe("presence", () => {
    it("ends with the business day, whether or not the reset has run", () => {
      const p = replay([entry("2027-07-01T10:00")], UNLIMITED);
      expect(isPresent(p, FACILITY, at("2027-07-01T22:00"))).to.equal(true);
      expect(isPresent(p, FACILITY, at("2027-07-02T02:59"))).to.equal(true);
      expect(isPresent(p, FACILITY, at("2027-07-02T03:00"))).to.equal(false);
    });

    it("ends after the maximum stay of the facility", () => {
      const p = replay([entry("2027-07-01T09:00")], UNLIMITED);
      const facility = { ...FACILITY, maxStayMinutes: 600 };
      expect(isPresent(p, facility, at("2027-07-01T18:59"))).to.equal(true);
      expect(isPresent(p, facility, at("2027-07-01T19:00"))).to.equal(false);
    });
  });

  describe("stateOf", () => {
    const cases = [
      [
        "issued before the first entry",
        UNLIMITED,
        [],
        "2027-07-01T10:00",
        S.ISSUED,
      ],
      [
        "present after an entry",
        UNLIMITED,
        [entry("2027-07-01T10:00")],
        "2027-07-01T12:00",
        S.PRESENT,
      ],
      [
        "absent after an exit",
        UNLIMITED,
        [entry("2027-07-01T10:00"), exit("2027-07-01T12:00")],
        "2027-07-01T13:00",
        S.ABSENT,
      ],
      [
        "absent the day after, without exit",
        UNLIMITED,
        [entry("2027-07-01T10:00")],
        "2027-07-02T09:00",
        S.ABSENT,
      ],
      [
        "consumed after the single entry",
        SINGLE,
        [entry("2027-07-01T10:00"), exit("2027-07-01T12:00")],
        "2027-07-01T13:00",
        S.CONSUMED,
      ],
      [
        "absent on the last quota day, since a re-entry is still possible",
        QUOTA,
        [
          entry("2027-07-01T10:00"),
          exit("2027-07-01T11:00"),
          entry("2027-07-02T10:00"),
          exit("2027-07-02T11:00"),
        ],
        "2027-07-02T12:00",
        S.ABSENT,
      ],
      [
        "consumed the day after the last quota day",
        QUOTA,
        [
          entry("2027-07-01T10:00"),
          exit("2027-07-01T11:00"),
          entry("2027-07-02T10:00"),
          exit("2027-07-02T11:00"),
        ],
        "2027-07-03T10:00",
        S.CONSUMED,
      ],
      [
        "expired after its window",
        UNLIMITED,
        [],
        "2027-09-16T00:00",
        S.EXPIRED,
      ],
      [
        "blocked over expired and present",
        UNLIMITED,
        [
          entry("2027-09-15T10:00"),
          event(E.BLOCK, "2027-09-15T11:00", {
            actor: STAFF,
            note: "Weitergabe",
          }),
        ],
        "2027-09-16T10:00",
        S.BLOCKED,
      ],
      [
        "void over blocked",
        UNLIMITED,
        [
          event(E.BLOCK, "2027-07-01T09:00", { actor: STAFF, note: "Prüfen" }),
          event(E.VOID, "2027-07-01T10:00", {
            cause: VOID_CAUSES.BOOKING_CANCELLED,
          }),
        ],
        "2027-07-01T11:00",
        S.VOID,
      ],
      [
        "valid again once the booking is reinstated",
        UNLIMITED,
        [
          event(E.VOID, "2027-07-01T10:00", {
            cause: VOID_CAUSES.BOOKING_CANCELLED,
          }),
          event(E.RESTORE, "2027-07-01T11:00"),
        ],
        "2027-07-01T12:00",
        S.ISSUED,
      ],
    ];
    cases.forEach(([name, terms, log, iso, expected]) => {
      it(name, () => expect(stateAt(log, terms, iso)).to.equal(expected));
    });
  });

  describe("correctionsOf", () => {
    it("offers what fits the state", () => {
      const present = replay([entry("2027-07-01T10:00")], UNLIMITED);
      expect(
        correctionsOf(present, UNLIMITED, FACILITY, at("2027-07-01T11:00")),
      ).to.deep.equal([
        E.RESET_PRESENCE,
        E.UNDO_ENTRY,
        E.BLOCK,
        E.VOID,
        E.REISSUE,
      ]);
    });

    it("leaves a void that follows the booking to the booking", () => {
      const cancelled = replay(
        [
          event(E.VOID, "2027-07-01T10:00", {
            cause: VOID_CAUSES.BOOKING_CANCELLED,
          }),
        ],
        UNLIMITED,
      );
      expect(
        correctionsOf(cancelled, UNLIMITED, FACILITY, at("2027-07-01T11:00")),
      ).to.deep.equal([]);
      const byHand = replay(
        [
          event(E.VOID, "2027-07-01T10:00", {
            cause: VOID_CAUSES.BY_ADMINISTRATION,
            actor: STAFF,
            note: "Fehlausstellung",
          }),
        ],
        UNLIMITED,
      );
      expect(
        correctionsOf(byHand, UNLIMITED, FACILITY, at("2027-07-01T11:00")),
      ).to.deep.equal([E.RESTORE]);
    });
  });

  describe("problemsOfEvent", () => {
    it("needs account and reason for every correction (Pos. 6.2)", () => {
      expect(problemsOfEvent(event(E.BLOCK, "2027-07-01T10:00"))).to.deep.equal(
        ["account_missing", "reason_missing"],
      );
      expect(
        problemsOfEvent(
          event(E.BLOCK, "2027-07-01T10:00", {
            actor: STAFF,
            note: "Weitergabe",
          }),
        ),
      ).to.deep.equal([]);
    });

    it("needs no account for what the booking or the scheduler triggers", () => {
      expect(
        problemsOfEvent(
          event(E.VOID, "2027-07-01T10:00", {
            cause: VOID_CAUSES.BOOKING_CANCELLED,
          }),
        ),
      ).to.deep.equal([]);
      expect(
        problemsOfEvent(event(E.DAY_RESET, "2027-07-02T03:00")),
      ).to.deep.equal([]);
    });

    it("undoes an existing entry only, and only once", () => {
      const first = entry("2027-07-01T10:00");
      const undo = event(E.UNDO_ENTRY, "2027-07-01T10:05", {
        entryId: first.id,
        actor: STAFF,
        note: "Fehlscan",
      });
      expect(problemsOfEvent(undo, [first])).to.deep.equal([]);
      expect(
        problemsOfEvent({ ...undo, entryId: "nope" }, [first]),
      ).to.deep.equal(["entry_unknown"]);
      expect(problemsOfEvent(undo, [first, undo])).to.deep.equal([
        "entry_already_undone",
      ]);
    });

    it("rejects unknown types and a void without cause", () => {
      expect(problemsOfEvent({ type: "teleport", at: 1 })).to.deep.equal([
        "unknown_type",
      ]);
      expect(problemsOfEvent(event(E.VOID, "2027-07-01T10:00"))).to.deep.equal([
        "cause_unknown",
      ]);
    });
  });
});
