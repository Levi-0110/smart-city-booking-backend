const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  planReset,
} = require("../src/commons/services/admission/admission-reset");
const {
  USAGE_EVENTS: E,
} = require("../src/commons/services/admission/admission-state");

const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const FACILITY = Object.freeze({
  resetTime: "03:00",
  zone: ZONE,
  lastResetAt: at("2027-07-01T03:00"),
});

describe("admission daily reset", () => {
  it("closes every presence of an earlier business day at the reset time", () => {
    const plan = planReset({
      facility: FACILITY,
      presences: [
        { passId: "yesterday", presentSince: at("2027-07-01T16:00") },
        { passId: "today", presentSince: at("2027-07-02T09:00") },
      ],
      now: at("2027-07-02T09:30"),
    });
    expect(plan.resetDue).to.equal(true);
    expect(plan.resetUpTo).to.equal(at("2027-07-02T03:00"));
    expect(plan.events).to.deep.equal([
      {
        passId: "yesterday",
        event: {
          type: E.DAY_RESET,
          at: at("2027-07-02T09:30"),
          closedAt: at("2027-07-02T03:00"),
          actor: { source: "scheduler" },
        },
      },
    ]);
  });

  it("closes a presence beyond the maximum stay, also during the day", () => {
    const plan = planReset({
      facility: {
        ...FACILITY,
        maxStayMinutes: 600,
        lastResetAt: at("2027-07-02T03:00"),
      },
      presences: [
        { passId: "long", presentSince: at("2027-07-02T08:00") },
        { passId: "short", presentSince: at("2027-07-02T12:00") },
      ],
      now: at("2027-07-02T18:05"),
    });
    expect(plan.resetDue).to.equal(false);
    expect(
      plan.events.map(({ passId, event }) => [
        passId,
        event.type,
        event.closedAt,
      ]),
    ).to.deep.equal([["long", E.AUTO_EXIT, at("2027-07-02T18:00")]]);
  });

  it("names the maximum stay when it ended a presence before the reset", () => {
    const plan = planReset({
      facility: { ...FACILITY, maxStayMinutes: 240 },
      presences: [{ passId: "evening", presentSince: at("2027-07-01T18:00") }],
      now: at("2027-07-02T09:00"),
    });
    expect(plan.events[0].event).to.include({
      type: E.AUTO_EXIT,
      closedAt: at("2027-07-01T22:00"),
    });
  });

  it("catches up after days without a run, in one go", () => {
    const plan = planReset({
      facility: FACILITY,
      presences: [
        { passId: "a", presentSince: at("2027-06-28T10:00") },
        { passId: "b", presentSince: at("2027-06-30T10:00") },
      ],
      now: at("2027-07-04T08:00"),
    });
    expect(plan.resetUpTo).to.equal(at("2027-07-04T03:00"));
    // Each presence ended with its own business day, not with the run.
    expect(
      plan.events.map(({ passId, event }) => [passId, event.closedAt]),
    ).to.deep.equal([
      ["a", at("2027-06-29T03:00")],
      ["b", at("2027-07-01T03:00")],
    ]);
  });

  it("finds nothing left to close on a second run", () => {
    const first = planReset({
      facility: FACILITY,
      presences: [{ passId: "a", presentSince: at("2027-07-01T10:00") }],
      now: at("2027-07-02T03:01"),
    });
    const second = planReset({
      facility: { ...FACILITY, lastResetAt: first.resetUpTo },
      presences: [],
      now: at("2027-07-02T03:06"),
    });
    expect(first.events).to.have.length(1);
    expect(second).to.deep.include({ resetDue: false, events: [] });
  });

  it("is due for a facility that was never reset", () => {
    const plan = planReset({
      facility: { resetTime: "03:00", zone: ZONE },
      presences: [],
      now: at("2027-07-02T10:00"),
    });
    expect(plan.resetDue).to.equal(true);
  });
});
