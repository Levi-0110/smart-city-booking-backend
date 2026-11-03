const { expect } = require("chai");
const sinon = require("sinon");
const { DateTime } = require("luxon");

const {
  MongoAdmissionStore,
} = require("../src/commons/services/admission/admission-store");

const TENANT = "bad-belzig";
const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const PASS = Object.freeze({ tenantId: TENANT, id: "pass-1", version: 4 });

/** A query that answers `value` to `.lean()`, also after `.sort()` or `.select()`. */
const query = (value) => {
  const chain = {
    lean: () => Promise.resolve(value),
    sort: () => chain,
    select: () => chain,
  };
  return chain;
};

describe("admission store in MongoDB", () => {
  let sandbox;
  let models;
  let store;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const model = () => ({
      create: sandbox.stub().resolves({}),
      updateOne: sandbox.stub().resolves({ matchedCount: 1 }),
      findOne: sandbox.stub().returns(query(null)),
      find: sandbox.stub().returns(query([])),
      countDocuments: sandbox.stub().resolves(0),
    });
    models = {
      passes: model(),
      events: model(),
      checks: model(),
      devices: model(),
      facilities: model(),
      bookables: model(),
    };
    store = new MongoAdmissionStore(models);
  });

  afterEach(() => sandbox.restore());

  it("appends an event at the next position of the log, then moves the projection on", async () => {
    const appended = await store.appendEvent(
      PASS,
      { id: "e5", type: "entry", at: 1 },
      { presentSince: 1 },
    );

    expect(appended).to.equal(true);
    expect(models.events.create.firstCall.args[0]).to.deep.include({
      tenantId: TENANT,
      passId: "pass-1",
      seq: 5,
    });
    expect(models.passes.updateOne.firstCall.args).to.deep.equal([
      { tenantId: TENANT, id: "pass-1", version: 4 },
      { $set: { projection: { presentSince: 1 }, version: 5 } },
    ]);
  });

  it("loses the race for a position quietly and leaves the projection alone", async () => {
    models.events.create.rejects(
      Object.assign(new Error("E11000"), { code: 11000 }),
    );

    expect(await store.appendEvent(PASS, { id: "e5" }, {})).to.equal(false);
    expect(models.passes.updateOne.called).to.equal(false);
  });

  it("counts the passes present in the business day and within the maximum stay", async () => {
    const facility = {
      id: "freibad",
      resetTime: "03:00",
      zone: ZONE,
      maxStayMinutes: 600,
    };

    await store.countPresent(TENANT, facility, at("2027-07-01T14:00"));
    await store.countPresent(
      TENANT,
      { ...facility, maxStayMinutes: null },
      at("2027-07-01T14:00"),
    );

    expect(models.passes.countDocuments.firstCall.args[0]).to.deep.equal({
      tenantId: TENANT,
      facilityId: "freibad",
      "projection.presentSince": {
        $gte: at("2027-07-01T03:00"),
        $gt: at("2027-07-01T04:00"),
      },
    });
    expect(
      models.passes.countDocuments.secondCall.args[0][
        "projection.presentSince"
      ],
    ).to.deep.equal({ $gte: at("2027-07-01T03:00") });
  });

  it("reserves a scan once and hands the earlier check to a second reservation", async () => {
    const earlier = { tenantId: TENANT, scanId: "scan-1", answer: { ok: 1 } };
    models.checks.create
      .onSecondCall()
      .rejects(Object.assign(new Error("E11000"), { code: 11000 }));
    models.checks.findOne.returns(query(earlier));
    const check = { tenantId: TENANT, scanId: "scan-1", at: 1 };

    expect(await store.reserveCheck(check)).to.deep.equal({ reserved: true });
    expect(await store.reserveCheck(check)).to.deep.equal({
      reserved: false,
      existing: earlier,
    });
    expect(models.checks.create.firstCall.args[0]).to.deep.include({
      answer: null,
    });
  });

  it("gives a facility its settings and the capacity of its bookable, or nothing", async () => {
    models.facilities.findOne.returns(
      query({ resetTime: "06:00", zone: ZONE, maxStayMinutes: 480 }),
    );
    models.bookables.findOne.returns(query({ amount: 1200 }));

    expect(await store.facility(TENANT, "freibad")).to.deep.include({
      id: "freibad",
      capacity: 1200,
      resetTime: "06:00",
      maxStayMinutes: 480,
    });

    models.facilities.findOne.returns(query(null));
    expect(await store.facility(TENANT, "freibad")).to.equal(null);
  });

  it("lists the passes of a booking and refuses a pass whose slot or code is taken", async () => {
    const pass = { tenantId: TENANT, id: "pass-1", bookingId: "B-1" };
    models.passes.create
      .onSecondCall()
      .rejects(Object.assign(new Error("E11000"), { code: 11000 }));

    await store.passesOfBooking(TENANT, "B-1");
    const inserted = [
      await store.insertPass(pass),
      await store.insertPass(pass),
    ];

    expect(models.passes.find.firstCall.args[0]).to.deep.equal({
      tenantId: TENANT,
      bookingId: "B-1",
    });
    expect(inserted).to.deep.equal([true, false]);
  });

  it("finds a pass by its code, and by a code it was reissued from", async () => {
    const pass = { id: "pass-1" };
    models.passes.findOne
      .onFirstCall()
      .returns(query(null))
      .onSecondCall()
      .returns(query(pass));

    expect(await store.passByCodeHash(TENANT, "h-old")).to.deep.equal({
      pass,
      retired: true,
    });
    expect(models.passes.findOne.secondCall.args[0]).to.deep.equal({
      tenantId: TENANT,
      retiredCodeHashes: "h-old",
    });
  });
});
