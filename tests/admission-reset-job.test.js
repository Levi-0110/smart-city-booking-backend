/**
 * The daily reset of admission as a job of the scheduler (docs/admission.md,
 * "Business day, daily reset, maximum stay" and "Scheduler"): what a run
 * closes, in which log, behind which scan, and how it is started with the
 * API.
 */

const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  createAdmissionResetJob,
  RESET_JOB_NAME,
} = require("../src/commons/services/admission/admission-reset-job");
const {
  MemoryAdmissionStore,
} = require("../src/commons/services/admission/admission-store");
const {
  emptyProjection,
} = require("../src/commons/services/admission/admission-state");
const {
  JobRunner,
  MemoryJobStore,
  RUN_OUTCOMES,
} = require("../src/commons/services/scheduler");
const {
  startPlatformScheduler,
  platformJobs,
  admissionResetEveryMs,
} = require("../src/commons/services/scheduler/platform-scheduler");

const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const NOW = at("2027-07-02T13:00");
const TERMS = Object.freeze({ usage: "unlimited" });
const SILENT = { warn() {}, error() {}, info() {} };

/** A pass of `facilityId` present since `since` (null: not present). */
function presentPass(tenantId, id, facilityId, since) {
  return {
    id,
    tenantId,
    facilityId,
    terms: TERMS,
    projection: {
      ...emptyProjection(TERMS),
      presentSince: since,
      presentEntryId: since === null ? null : `entry-of-${id}`,
    },
    version: 0,
  };
}

function world() {
  const store = new MemoryAdmissionStore();
  store.putFacility({
    tenantId: "bad-belzig",
    id: "freibad",
    resetTime: "03:00",
    zone: ZONE,
    maxStayMinutes: 240,
    lastResetAt: at("2027-07-01T03:00"),
  });
  store.putFacility({
    tenantId: "bad-belzig",
    id: "hallenbad",
    resetTime: "03:00",
    zone: ZONE,
  });
  store.putFacility({
    tenantId: "wiesenburg",
    id: "waldbad",
    resetTime: "05:00",
    zone: ZONE,
  });
  for (const pass of [
    presentPass("bad-belzig", "night", "freibad", at("2027-07-01T23:30")),
    presentPass("bad-belzig", "long", "freibad", at("2027-07-02T08:00")),
    presentPass("bad-belzig", "fresh", "freibad", at("2027-07-02T11:00")),
    presentPass("bad-belzig", "swim", "hallenbad", at("2027-07-02T09:00")),
    presentPass("wiesenburg", "old", "waldbad", at("2027-06-29T10:00")),
    presentPass("bad-belzig", "gone", "freibad", null),
  ]) {
    store.putPass(pass);
  }
  let ids = 0;
  const job = createAdmissionResetJob({
    store,
    now: () => NOW,
    newId: () => `reset-${(ids += 1)}`,
  });
  return { store, job };
}

const logOf = async (store, tenantId, passId) =>
  (await store.eventsAfter(tenantId, passId, 0)).map(
    ({ type, at: time, closedAt, actor }) => ({
      type,
      at: time,
      closedAt,
      actor,
    }),
  );

describe("admission reset job", () => {
  it("closes the presences of an earlier day and beyond the maximum stay, in every tenant", async () => {
    const { store, job } = world();

    const summary = await job.run({ now: NOW });

    expect(summary).to.deep.equal({ facilities: 3, closed: 3, failed: 0 });
    const scheduler = { source: "scheduler" };
    expect(await logOf(store, "bad-belzig", "night")).to.deep.equal([
      {
        type: "day_reset",
        at: NOW,
        closedAt: at("2027-07-02T03:00"),
        actor: scheduler,
      },
    ]);
    expect(await logOf(store, "bad-belzig", "long")).to.deep.equal([
      {
        type: "auto_exit",
        at: NOW,
        closedAt: at("2027-07-02T12:00"),
        actor: scheduler,
      },
    ]);
    // Three days late: closed at the end of its own business day.
    expect(await logOf(store, "wiesenburg", "old")).to.deep.equal([
      {
        type: "day_reset",
        at: NOW,
        closedAt: at("2027-06-30T05:00"),
        actor: scheduler,
      },
    ]);
    for (const [tenantId, passId] of [
      ["bad-belzig", "fresh"],
      ["bad-belzig", "swim"],
      ["bad-belzig", "gone"],
    ]) {
      expect(await logOf(store, tenantId, passId)).to.deep.equal([]);
    }
    const presentSince = async (tenantId, passId) =>
      (await store.passById(tenantId, passId)).projection.presentSince;
    expect(await presentSince("bad-belzig", "night")).to.equal(null);
    expect(await presentSince("bad-belzig", "fresh")).to.equal(
      at("2027-07-02T11:00"),
    );
    expect(
      (await store.allFacilitySettings()).map(({ facilityId, lastResetAt }) => [
        facilityId,
        lastResetAt,
      ]),
    ).to.deep.equal([
      ["freibad", at("2027-07-02T03:00")],
      ["hallenbad", at("2027-07-02T03:00")],
      ["waldbad", at("2027-07-02T05:00")],
    ]);
  });

  it("closes nothing more on a second run", async () => {
    const { store, job } = world();

    await job.run({ now: NOW });
    const second = await job.run({ now: NOW + 60 * 1000 });

    expect(second).to.deep.equal({ facilities: 3, closed: 0, failed: 0 });
    expect(await store.eventsAfter("bad-belzig", "night", 1)).to.deep.equal([]);
  });

  it("keeps the exit of a guest who scanned out while the run was under way", async () => {
    const { store, job } = world();
    const read = store.passById.bind(store);
    let scanned = false;
    store.passById = async (tenantId, passId) => {
      if (passId === "night" && !scanned) {
        scanned = true;
        const pass = await read(tenantId, passId);
        await store.appendEvent(
          pass,
          {
            id: "exit-1",
            type: "exit",
            at: NOW - 1000,
            actor: { source: "device", deviceId: "gate-1" },
          },
          { ...pass.projection, presentSince: null, presentEntryId: null },
        );
      }
      return read(tenantId, passId);
    };

    const summary = await job.run({ now: NOW });

    expect(summary.closed).to.equal(2);
    expect(
      (await logOf(store, "bad-belzig", "night")).map(({ type }) => type),
    ).to.deep.equal(["exit"]);
  });

  it("fails the run for a pass it cannot write, closes the others and keeps that facility's mark", async () => {
    const { store, job } = world();
    const append = store.appendEvent.bind(store);
    store.appendEvent = async (pass, event, projection) =>
      pass.id === "long" ? false : append(pass, event, projection);

    let failure = null;
    try {
      await job.run({ now: NOW });
    } catch (err) {
      failure = err;
    }

    expect(failure?.message).to.include(
      "admission reset: 1 presence(s) not closed: bad-belzig/freibad/long",
    );
    expect(await logOf(store, "bad-belzig", "long")).to.deep.equal([]);
    expect(
      (await logOf(store, "bad-belzig", "night")).map(({ type }) => type),
    ).to.deep.equal(["day_reset"]);
    const marks = Object.fromEntries(
      (await store.allFacilitySettings()).map(({ facilityId, lastResetAt }) => [
        facilityId,
        lastResetAt,
      ]),
    );
    expect(marks).to.deep.equal({
      freibad: at("2027-07-01T03:00"),
      hallenbad: at("2027-07-02T03:00"),
      waldbad: at("2027-07-02T05:00"),
    });
  });

  it("runs in the scheduler: at once, then every five minutes", async () => {
    const { job } = world();
    let clock = NOW;
    const runner = new JobRunner({
      store: new MemoryJobStore(),
      now: () => clock,
      logger: SILENT,
    }).register(job);

    const first = await runner.tick();
    clock += 60 * 1000;
    const early = await runner.tick();
    clock += 4 * 60 * 1000;
    const due = await runner.tick();

    expect(job.name).to.equal(RESET_JOB_NAME);
    expect(first[0]).to.deep.include({
      outcome: RUN_OUTCOMES.SUCCEEDED,
      result: { facilities: 3, closed: 3, failed: 0 },
    });
    expect(early[0].outcome).to.equal(RUN_OUTCOMES.SKIPPED);
    expect(due[0]).to.deep.include({
      outcome: RUN_OUTCOMES.SUCCEEDED,
      result: { facilities: 3, closed: 0, failed: 0 },
    });
  });

  it("starts with the API, unless the instance is switched off", async () => {
    const { job } = world();

    expect(
      startPlatformScheduler({ env: { SCHEDULER_ENABLED: "false" } }),
    ).to.equal(null);
    const runner = startPlatformScheduler({
      env: {},
      store: new MemoryJobStore(),
      jobs: [job],
      tickMs: 60 * 60 * 1000,
      logger: SILENT,
    });
    await runner.stop();

    expect([...runner.jobs.keys()]).to.deep.equal([RESET_JOB_NAME]);
    expect((await runner.status())[0]).to.deep.include({
      name: RESET_JOB_NAME,
      failures: 0,
      healthy: true,
    });
    expect(
      platformJobs({}).map(({ name, everyMs }) => [name, everyMs]),
    ).to.deep.equal([[RESET_JOB_NAME, 5 * 60 * 1000]]);
    expect(
      [undefined, "10", "0", "61", "2.5"].map((minutes) =>
        admissionResetEveryMs({ ADMISSION_RESET_INTERVAL_MINUTES: minutes }),
      ),
    ).to.deep.equal([300000, 600000, 300000, 300000, 300000]);
  });
});
