const { expect } = require("chai");
const sinon = require("sinon");

const {
  JobRunner,
  RUN_OUTCOMES,
  MemoryJobStore,
  MongoJobStore,
} = require("../src/commons/services/scheduler");
const {
  nextSlot,
  retryDelay,
} = require("../src/commons/services/scheduler/job-runner");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2027, 6, 1, 1, 0); // 2027-07-01 03:00 in Berlin

const silent = { warn: () => {}, error: () => {}, info: () => {} };

/** A runner on a shared store with a clock the test moves. */
function setup({ store = new MemoryJobStore(), owner = "instance-a" } = {}) {
  const clock = { now: T0 };
  const runner = new JobRunner({
    store,
    owner,
    now: () => clock.now,
    logger: silent,
  });
  return { clock, runner, store };
}

describe("scheduler job runner", () => {
  it("runs a new job at once and then on its interval", async () => {
    const { clock, runner } = setup();
    const run = sinon.stub().resolves({ closed: 0 });
    runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run });

    expect((await runner.tick())[0].outcome).to.equal(RUN_OUTCOMES.SUCCEEDED);
    clock.now += 4 * MINUTE;
    expect((await runner.tick())[0].outcome).to.equal(RUN_OUTCOMES.SKIPPED);
    clock.now += 1 * MINUTE;
    expect((await runner.tick())[0].outcome).to.equal(RUN_OUTCOMES.SUCCEEDED);
    expect(run.callCount).to.equal(2);
    expect(run.secondCall.args[0]).to.deep.include({ dueAt: T0 + 5 * MINUTE });
  });

  it("catches up once after a downtime and tells the run since when it was due", async () => {
    const { clock, runner } = setup();
    const run = sinon.stub().resolves();
    runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run });
    await runner.tick();

    clock.now += 3 * 60 * MINUTE + 2 * MINUTE; // three hours down
    await runner.tick();
    await runner.tick();

    expect(run.callCount).to.equal(2);
    expect(run.secondCall.args[0].dueAt).to.equal(T0 + 5 * MINUTE);
    const [status] = await runner.status();
    expect(status.nextRunAt).to.be.above(clock.now);
    expect(status.nextRunAt - clock.now).to.be.at.most(5 * MINUTE);
  });

  it("lets only one of two instances run a due job", async () => {
    const store = new MemoryJobStore();
    const a = setup({ store, owner: "instance-a" });
    const b = setup({ store, owner: "instance-b" });
    let release;
    const slow = () => new Promise((resolve) => (release = resolve));
    a.runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run: slow });
    const runB = sinon.stub().resolves();
    b.runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run: runB });

    const tickA = a.runner.tick();
    await new Promise(setImmediate);
    const [outcomeB] = await b.runner.tick();
    release();
    const [outcomeA] = await tickA;

    expect(outcomeA.outcome).to.equal(RUN_OUTCOMES.SUCCEEDED);
    expect(outcomeB.outcome).to.equal(RUN_OUTCOMES.SKIPPED);
    expect(runB.called).to.equal(false);
  });

  it("takes over the job of an instance that died in a run", async () => {
    const store = new MemoryJobStore();
    const a = setup({ store, owner: "instance-a" });
    await store.ensure("day-reset", T0);
    await store.acquire("day-reset", {
      now: T0,
      owner: "instance-a",
      leaseMs: 5 * MINUTE,
    });

    const run = sinon.stub().resolves();
    const b = setup({ store, owner: "instance-b" });
    b.runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run });
    b.clock.now = T0 + 2 * MINUTE;
    expect((await b.runner.tick())[0].outcome).to.equal(RUN_OUTCOMES.SKIPPED);
    b.clock.now = T0 + 5 * MINUTE;
    expect((await b.runner.tick())[0].outcome).to.equal(RUN_OUTCOMES.SUCCEEDED);
    expect(a.clock.now).to.equal(T0);
  });

  it("retries a failed run with a growing delay and keeps when it was due", async () => {
    const { clock, runner } = setup();
    const run = sinon.stub();
    run.onFirstCall().rejects(new Error("mongo down"));
    run.onSecondCall().rejects(new Error("mongo down"));
    run.onThirdCall().resolves();
    runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run });

    await runner.tick();
    let [status] = await runner.status();
    expect(status).to.deep.include({ failures: 1, healthy: false });
    expect(status.lastError.message).to.equal("mongo down");
    expect(status.nextRunAt).to.equal(T0 + 30 * SECOND);

    clock.now = T0 + 30 * SECOND;
    await runner.tick();
    [status] = await runner.status();
    expect(status.nextRunAt).to.equal(clock.now + 60 * SECOND);

    clock.now += 60 * SECOND;
    await runner.tick();
    expect(run.thirdCall.args[0].dueAt).to.equal(T0);
    [status] = await runner.status();
    expect(status).to.deep.include({
      failures: 0,
      lastError: null,
      healthy: true,
    });
  });

  it("reports a job as overdue when it has not succeeded for three intervals", async () => {
    const { clock, runner } = setup();
    runner.register({
      name: "day-reset",
      everyMs: 5 * MINUTE,
      run: sinon.stub().rejects(new Error("boom")),
    });
    await runner.tick();
    clock.now += 16 * MINUTE;
    const [status] = await runner.status();
    expect(status).to.deep.include({ overdue: true, healthy: false });
  });

  it("refuses a job without name, interval or run, and a name twice", () => {
    const { runner } = setup();
    expect(() => runner.register({ everyMs: MINUTE, run: () => {} })).to.throw(
      /unique name/,
    );
    expect(() => runner.register({ name: "x", run: () => {} })).to.throw(
      /interval/,
    );
    runner.register({ name: "x", everyMs: MINUTE, run: () => {} });
    expect(() =>
      runner.register({ name: "x", everyMs: MINUTE, run: () => {} }),
    ).to.throw(/unique name/);
  });

  it("ticks on a timer until stopped", async () => {
    const { runner } = setup();
    const run = sinon.stub().resolves();
    runner.register({ name: "day-reset", everyMs: 5 * MINUTE, run });
    runner.start({ tickMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runner.stop();
    expect(run.callCount).to.equal(1);
  });

  describe("grid and back-off", () => {
    it("keeps the rhythm of the interval and skips missed slots", () => {
      expect(nextSlot(T0, 5 * MINUTE, T0 + 1 * MINUTE)).to.equal(
        T0 + 5 * MINUTE,
      );
      expect(nextSlot(T0, 5 * MINUTE, T0 + 5 * MINUTE)).to.equal(
        T0 + 10 * MINUTE,
      );
      expect(nextSlot(T0, 5 * MINUTE, T0 + 61 * MINUTE)).to.equal(
        T0 + 65 * MINUTE,
      );
    });

    it("doubles the retry delay up to the interval", () => {
      expect(
        [1, 2, 3, 4, 5].map((n) => retryDelay(n, 5 * MINUTE)),
      ).to.deep.equal([
        30 * SECOND,
        60 * SECOND,
        120 * SECOND,
        240 * SECOND,
        300 * SECOND,
      ]);
    });
  });

  describe("MongoJobStore", () => {
    let sandbox;
    let model;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      model = {
        updateOne: sandbox.stub().resolves({ matchedCount: 1 }),
        findOneAndUpdate: sandbox
          .stub()
          .returns({ lean: () => Promise.resolve(null) }),
        find: sandbox.stub().returns({ lean: () => Promise.resolve([]) }),
      };
    });

    afterEach(() => sandbox.restore());

    it("leases a job only when it is due and free, in one conditional update", async () => {
      await new MongoJobStore(model).acquire("day-reset", {
        now: T0,
        owner: "instance-a",
        leaseMs: 5 * MINUTE,
      });
      const [filter, update] = model.findOneAndUpdate.firstCall.args;
      expect(filter).to.deep.equal({
        name: "day-reset",
        nextRunAt: { $lte: T0 },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: T0 } }],
      });
      expect(update).to.deep.equal({
        $set: { leaseOwner: "instance-a", leaseUntil: T0 + 5 * MINUTE },
      });
    });

    it("writes a result only while holding the lease", async () => {
      const store = new MongoJobStore(model);
      expect(
        await store.release("day-reset", "instance-a", { failures: 0 }),
      ).to.equal(true);
      expect(model.updateOne.firstCall.args[0]).to.deep.equal({
        name: "day-reset",
        leaseOwner: "instance-a",
      });
      model.updateOne.resolves({ matchedCount: 0 });
      expect(
        await store.release("day-reset", "instance-a", { failures: 0 }),
      ).to.equal(false);
    });

    it("creates a job once, also when two instances start together", async () => {
      model.updateOne.rejects(
        Object.assign(new Error("E11000"), { code: 11000 }),
      );
      await new MongoJobStore(model).ensure("day-reset", T0);
      const [filter, update, options] = model.updateOne.firstCall.args;
      expect(filter).to.deep.equal({ name: "day-reset" });
      expect(update.$setOnInsert).to.include({
        name: "day-reset",
        nextRunAt: T0,
      });
      expect(options).to.deep.equal({ upsert: true });
    });
  });
});
