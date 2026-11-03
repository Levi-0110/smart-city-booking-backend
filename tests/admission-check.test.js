const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  snapshotTerms,
} = require("../src/commons/services/admission/admission-terms");
const {
  USAGE_EVENTS: E,
  businessDayOf,
  replay,
} = require("../src/commons/services/admission/admission-state");
const {
  ADMISSION_STEPS: STEP,
  ADMISSION_RESULT: R,
  DENIAL_REASONS: D,
  ADMISSION_NOTICES: N,
  VOID_CAUSES,
} = require("../src/commons/services/admission/admission-reasons");
const {
  DIRECTION,
  CODE_STATUS,
  decide,
} = require("../src/commons/services/admission/admission-check");

const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const FACILITY = Object.freeze({
  id: "freibad",
  capacity: 500,
  presentCount: 120,
  resetTime: "03:00",
  maxStayMinutes: null,
  zone: ZONE,
});
const STAFF = Object.freeze({ source: "administration", userId: "staff-1" });

/** Season May 15 to September 15, the tariffs of a public pool. */
const SEASON = Object.freeze({
  validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
  usage: { type: "unlimited" },
  lockMinutes: 0,
});
const SINGLE = { ...SEASON, usage: { type: "single" } };
const QUOTA = { ...SEASON, usage: { type: "quota", quota: 10 } };

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

function pass(definition = SEASON, log = [], extra = {}) {
  const terms = snapshotTerms(definition, { issuedAt: at("2027-05-01T09:00") });
  return {
    id: "pass-1",
    facilityId: "freibad",
    label: "Saisonkarte",
    holder: { name: "Erika Mustermann" },
    terms,
    projection: replay(log, terms),
    ...extra,
  };
}

function check(thePass, iso, input = {}) {
  return decide({
    codeStatus: CODE_STATUS.FOUND,
    pass: thePass,
    facility: FACILITY,
    now: at(iso),
    ...input,
  });
}

describe("admission check", () => {
  describe("each step refuses with its reason", () => {
    const cases = [
      [
        "an unreadable code",
        { codeStatus: CODE_STATUS.UNREADABLE, pass: null },
        D.CODE_UNREADABLE,
        STEP.CODE,
        "Code nicht lesbar",
      ],
      [
        "the booking confirmation",
        { codeStatus: CODE_STATUS.NOT_A_TICKET, pass: null },
        D.NOT_A_TICKET,
        STEP.CODE,
        "Kein Ticket: Buchungsbestätigung oder Buchungsnummer",
      ],
      [
        "a forged code",
        { codeStatus: CODE_STATUS.NOT_GENUINE, pass: null },
        D.CODE_NOT_GENUINE,
        STEP.CODE,
        "Code nicht von diesem Betrieb ausgestellt",
      ],
      [
        "an unknown code",
        { codeStatus: CODE_STATUS.UNKNOWN, pass: null },
        D.CODE_UNKNOWN,
        STEP.CODE,
        "Code unbekannt",
      ],
      [
        "the old code of a reissued pass",
        {
          codeStatus: CODE_STATUS.REPLACED,
          pass: pass(SEASON, [], { replacedAt: at("2027-07-01T09:00") }),
        },
        D.CODE_REPLACED,
        STEP.CODE,
        "Code ersetzt: neues Ticket vorzeigen",
      ],
      [
        "a pass of another facility",
        { pass: pass(SEASON, [], { facilityId: "hallenbad" }) },
        D.OTHER_FACILITY,
        STEP.CODE,
        "Gilt für eine andere Einrichtung",
      ],
      [
        "a cancelled booking",
        {
          pass: pass(SEASON, [
            event(E.VOID, "2027-06-30T10:00", {
              cause: VOID_CAUSES.BOOKING_CANCELLED,
            }),
          ]),
        },
        D.VOIDED,
        STEP.VALIDITY,
        "Ungültig: Buchung storniert",
      ],
      [
        "a blocked pass",
        {
          pass: pass(SEASON, [
            event(E.BLOCK, "2027-06-30T10:00", {
              actor: STAFF,
              note: "Karte weitergegeben",
            }),
          ]),
        },
        D.BLOCKED,
        STEP.VALIDITY,
        "Gesperrt: Karte weitergegeben",
      ],
      [
        "a pass before its season",
        { now: at("2027-05-10T10:00") },
        D.NOT_YET_VALID,
        STEP.VALIDITY,
        "Gültig ab 15.05.2027",
      ],
      [
        "a pass after its season",
        { now: at("2027-09-16T10:00") },
        D.EXPIRED,
        STEP.VALIDITY,
        "Abgelaufen am 15.09.2027",
      ],
      [
        "a used single entry",
        {
          pass: pass(SINGLE, [
            entry("2027-07-01T09:30"),
            exit("2027-07-01T09:50"),
          ]),
        },
        D.SINGLE_ENTRY_USED,
        STEP.USAGE,
        "Einmaleintritt bereits genutzt um 01.07.2027 09:30",
      ],
      [
        "a quota used up on earlier days",
        {
          pass: pass({ ...SEASON, usage: { type: "quota", quota: 2 } }, [
            entry("2027-06-29T10:00"),
            exit("2027-06-29T12:00"),
            entry("2027-06-30T10:00"),
            exit("2027-06-30T12:00"),
          ]),
        },
        D.QUOTA_EXHAUSTED,
        STEP.USAGE,
        "Kontingent aufgebraucht (2 von 2)",
      ],
      [
        "a pass still checked in",
        { pass: pass(SEASON, [entry("2027-07-01T09:15")]) },
        D.ALREADY_PRESENT,
        STEP.PRESENCE,
        "Bereits eingecheckt seit 09:15, kein Austritt erfasst",
      ],
      [
        "a re-entry within the lock period",
        {
          pass: pass({ ...SEASON, lockMinutes: 180 }, [
            entry("2027-07-01T08:30"),
            exit("2027-07-01T09:00"),
          ]),
        },
        D.LOCK_PERIOD,
        STEP.LOCK_PERIOD,
        "Erneuter Eintritt ab 11:30 möglich",
      ],
      [
        "a full facility, where the tariff checks at entry",
        {
          pass: pass({ ...SEASON, capacityCheck: "entry" }),
          facility: { ...FACILITY, capacity: 120, presentCount: 120 },
        },
        D.CAPACITY_REACHED,
        STEP.CAPACITY,
        "Einrichtung voll: 120 von 120 eingecheckt",
      ],
    ];

    cases.forEach(([name, input, reason, step, message]) => {
      it(`refuses ${name}`, () => {
        const decision = check(pass(), "2027-07-01T10:00", input);
        expect(decision).to.include({
          result: R.DENIED,
          reason,
          step,
          message,
        });
        expect(decision.effect).to.equal(null);
      });
    });
  });

  describe("the first refusing step decides", () => {
    it("names the facility before the block", () => {
      const thePass = pass(
        SEASON,
        [event(E.BLOCK, "2027-06-30T10:00", { actor: STAFF, note: "Prüfen" })],
        { facilityId: "hallenbad" },
      );
      expect(check(thePass, "2027-07-01T10:00").reason).to.equal(
        D.OTHER_FACILITY,
      );
    });

    it("names a void before a block, a block before the expiry", () => {
      const blocked = [
        event(E.BLOCK, "2027-06-30T10:00", { actor: STAFF, note: "Prüfen" }),
      ];
      const voided = [
        ...blocked,
        event(E.VOID, "2027-06-30T11:00", {
          cause: VOID_CAUSES.BOOKING_WITHDRAWN,
        }),
      ];
      expect(check(pass(SEASON, voided), "2027-09-20T10:00").reason).to.equal(
        D.VOIDED,
      );
      expect(check(pass(SEASON, blocked), "2027-09-20T10:00").reason).to.equal(
        D.BLOCKED,
      );
    });

    it("names the used single entry before the presence", () => {
      expect(
        check(pass(SINGLE, [entry("2027-07-01T09:00")]), "2027-07-01T10:00")
          .reason,
      ).to.equal(D.SINGLE_ENTRY_USED);
    });

    it("names the presence before the lock period", () => {
      const thePass = pass({ ...SEASON, lockMinutes: 180 }, [
        entry("2027-07-01T09:00"),
      ]);
      expect(check(thePass, "2027-07-01T10:00").reason).to.equal(
        D.ALREADY_PRESENT,
      );
    });

    it("names the lock period before the capacity", () => {
      const thePass = pass(
        { ...SEASON, lockMinutes: 180, capacityCheck: "entry" },
        [entry("2027-07-01T09:00"), exit("2027-07-01T09:30")],
      );
      const decision = check(thePass, "2027-07-01T10:00", {
        facility: { ...FACILITY, capacity: 120, presentCount: 120 },
      });
      expect(decision.reason).to.equal(D.LOCK_PERIOD);
    });
  });

  describe("granted", () => {
    it("enters a season card and writes the entry as the only effect", () => {
      const decision = check(pass(), "2027-07-01T10:00");
      expect(decision).to.include({
        result: R.GRANTED,
        step: null,
        reason: null,
        message: "Eintritt gewährt",
      });
      expect(decision.notices).to.deep.equal([]);
      expect(decision.effect).to.deep.equal({
        type: E.ENTRY,
        at: at("2027-07-01T10:00"),
        day: "2027-07-01",
        consumesDay: false,
      });
      expect(decision.pass).to.include({ id: "pass-1", state: "present" });
    });

    it("lets a guest in who left without scanning yesterday (no reset needed)", () => {
      const thePass = pass({ ...SEASON, lockMinutes: 180 }, [
        entry("2027-06-30T10:00"),
      ]);
      expect(check(thePass, "2027-07-01T10:00").result).to.equal(R.GRANTED);
    });

    it("lets a guest in after the maximum stay of the facility", () => {
      const thePass = pass(SEASON, [entry("2027-07-01T08:00")]);
      const decision = check(thePass, "2027-07-01T18:30", {
        facility: { ...FACILITY, maxStayMinutes: 600 },
      });
      expect(decision.result).to.equal(R.GRANTED);
    });

    it("lets a guest in once the lock period is over", () => {
      const thePass = pass({ ...SEASON, lockMinutes: 180 }, [
        entry("2027-07-01T07:00"),
        exit("2027-07-01T08:00"),
      ]);
      expect(check(thePass, "2027-07-01T10:00").result).to.equal(R.GRANTED);
    });

    it("consumes a day of quota on the first entry of the day", () => {
      const decision = check(pass(QUOTA), "2027-07-01T10:00");
      expect(decision.effect.consumesDay).to.equal(true);
      expect(decision.pass.quotaLeft).to.equal(9);
    });

    it("lets a quota card re-enter the same day without using quota", () => {
      const thePass = pass(QUOTA, [
        entry("2027-07-01T09:00"),
        exit("2027-07-01T11:00"),
      ]);
      const decision = check(thePass, "2027-07-01T14:00");
      expect(decision.result).to.equal(R.GRANTED_WITH_NOTICE);
      expect(decision.notices.map((n) => n.code)).to.deep.equal([
        N.REENTRY_NO_QUOTA,
      ]);
      expect(decision.effect.consumesDay).to.equal(false);
      expect(decision.pass.quotaLeft).to.equal(9);
    });

    it("lets a used-up quota card re-enter on its last day", () => {
      const thePass = pass({ ...SEASON, usage: { type: "quota", quota: 1 } }, [
        entry("2027-07-01T09:00"),
        exit("2027-07-01T11:00"),
      ]);
      const decision = check(thePass, "2027-07-01T15:00");
      expect(decision.result).to.equal(R.GRANTED_WITH_NOTICE);
      expect(decision.pass.quotaLeft).to.equal(0);
    });

    it("points out the last day of a quota", () => {
      const thePass = pass({ ...SEASON, usage: { type: "quota", quota: 2 } }, [
        entry("2027-06-30T10:00"),
        exit("2027-06-30T12:00"),
      ]);
      const decision = check(thePass, "2027-07-01T10:00");
      expect(decision.notices.map((n) => n.message)).to.deep.equal([
        "Letzter Tag des Kontingents",
      ]);
    });

    it("asks to compare the person on a personal tariff", () => {
      const decision = check(
        pass({ ...SEASON, personal: { required: true, photo: true } }),
        "2027-07-01T10:00",
      );
      expect(decision.result).to.equal(R.GRANTED_WITH_NOTICE);
      expect(decision.notices).to.deep.equal([
        { code: N.CHECK_PERSON, message: "Person prüfen: Erika Mustermann" },
      ]);
      expect(decision.pass.holder).to.equal("Erika Mustermann");
    });

    it("does not show the holder of an impersonal tariff", () => {
      expect(check(pass(), "2027-07-01T10:00").pass.holder).to.equal(null);
    });

    it("enters past a full facility where the tariff checks at booking", () => {
      const decision = check(pass(), "2027-07-01T10:00", {
        facility: { ...FACILITY, capacity: 120, presentCount: 150 },
      });
      expect(decision.result).to.equal(R.GRANTED);
    });
  });

  describe("notices on patterns (Pos. 5.5)", () => {
    it("points out repeated refused attempts, and still decides the same", () => {
      const thePass = pass({ ...SEASON, lockMinutes: 180 }, [
        entry("2027-07-01T09:00"),
        exit("2027-07-01T09:10"),
      ]);
      const first = check(thePass, "2027-07-01T09:20");
      const second = check(thePass, "2027-07-01T09:25", {
        history: { refusedSinceEntry: 1 },
      });
      expect(first.notices).to.deep.equal([]);
      expect(second).to.include({ result: R.DENIED, reason: D.LOCK_PERIOD });
      expect(second.notices).to.deep.equal([
        {
          code: N.REPEATED_ATTEMPTS,
          message: "Hinweis: 2 abgewiesene Versuche in der Sperrzeit",
        },
      ]);
    });

    it("points out unusually many entries in one day", () => {
      const thePass = pass(SEASON, [
        entry("2027-07-01T09:00"),
        exit("2027-07-01T09:30"),
        entry("2027-07-01T10:00"),
        exit("2027-07-01T10:30"),
      ]);
      const decision = check(thePass, "2027-07-01T11:00");
      expect(decision.result).to.equal(R.GRANTED_WITH_NOTICE);
      expect(decision.notices).to.deep.equal([
        { code: N.FREQUENT_USE, message: "Hinweis: heute schon 3 Eintritte" },
      ]);
    });

    it("takes the thresholds of the facility", () => {
      const thePass = pass(SEASON, [
        entry("2027-07-01T09:00"),
        exit("2027-07-01T09:30"),
      ]);
      const decision = check(thePass, "2027-07-01T11:00", {
        facility: { ...FACILITY, warnings: { entriesPerDay: 5 } },
      });
      expect(decision.result).to.equal(R.GRANTED);
    });
  });

  describe("exit scan", () => {
    it("closes the presence", () => {
      const decision = check(
        pass(SEASON, [entry("2027-07-01T09:00")]),
        "2027-07-01T12:00",
        {
          direction: DIRECTION.EXIT,
        },
      );
      expect(decision).to.include({
        result: R.EXITED,
        message: "Austritt erfasst",
      });
      expect(decision.effect).to.deep.equal({
        type: E.EXIT,
        at: at("2027-07-01T12:00"),
      });
    });

    it("changes nothing for a pass that is not checked in", () => {
      const decision = check(pass(), "2027-07-01T12:00", {
        direction: DIRECTION.EXIT,
      });
      expect(decision).to.include({ result: R.NOT_PRESENT, effect: null });
    });

    it("still lets out a pass that expired or was blocked inside", () => {
      const log = [
        entry("2027-09-15T18:00"),
        event(E.BLOCK, "2027-09-15T18:30", { actor: STAFF, note: "Prüfen" }),
      ];
      const decision = check(pass(SEASON, log), "2027-09-15T23:30", {
        direction: DIRECTION.EXIT,
      });
      expect(decision.result).to.equal(R.EXITED);
    });

    it("refuses a code it cannot resolve", () => {
      const decision = check(null, "2027-07-01T12:00", {
        direction: DIRECTION.EXIT,
        codeStatus: CODE_STATUS.UNKNOWN,
      });
      expect(decision).to.include({ result: R.DENIED, reason: D.CODE_UNKNOWN });
    });
  });

  it("fills every placeholder of every message", () => {
    const decisions = [
      check(
        pass(SEASON, [
          event(E.BLOCK, "2027-06-30T10:00", { actor: STAFF, note: "" }),
        ]),
        "2027-07-01T10:00",
      ),
      check(null, "2027-07-01T10:00", { codeStatus: CODE_STATUS.REPLACED }),
      check(pass(SEASON, [entry("2027-07-01T09:00")]), "2027-07-01T10:00", {
        history: { refusedSinceEntry: 4 },
      }),
    ];
    decisions.forEach((decision) => {
      expect(decision.message).not.to.match(/\{\w+\}/);
      decision.notices.forEach((n) =>
        expect(n.message).not.to.match(/\{\w+\}/),
      );
    });
  });
});
