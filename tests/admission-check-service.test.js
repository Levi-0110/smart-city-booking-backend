const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  AdmissionCheckService,
  PENDING_TIMEOUT_MS,
} = require("../src/commons/services/admission/admission-check-service");
const {
  MemoryAdmissionStore,
} = require("../src/commons/services/admission/admission-store");
const {
  snapshotTerms,
} = require("../src/commons/services/admission/admission-terms");
const {
  emptyProjection,
  USAGE_EVENTS: E,
} = require("../src/commons/services/admission/admission-state");
const {
  ADMISSION_RESULT: R,
  DENIAL_REASONS: D,
  ADMISSION_NOTICES: N,
} = require("../src/commons/services/admission/admission-reasons");
const {
  formatIdentifier,
  lookupHash,
  payloadOf,
  tenantKey,
  checkSymbolOf,
} = require("../src/commons/services/admission/admission-code");

const TENANT = "bad-belzig";
const SECRET = "a-secret-of-at-least-thirty-two-characters";
const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

const FACILITY = Object.freeze({
  tenantId: TENANT,
  id: "freibad",
  capacity: 500,
  resetTime: "03:00",
  zone: ZONE,
  maxStayMinutes: null,
});
const GATE = Object.freeze({ id: "gate-1", facilityId: "freibad" });
const SIDE_GATE = Object.freeze({ id: "gate-2", facilityId: "freibad" });

const SEASON = Object.freeze({
  validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
  usage: { type: "unlimited" },
  lockMinutes: 0,
});

const identifierOf = (body) => body + checkSymbolOf(body);
const SEASON_ID = identifierOf("7KQ2M9XD4RTBH3W");
const OTHER_ID = identifierOf("4RTBH3W7KQ2M9XD");

function passFor(identifier, definition = SEASON, extra = {}) {
  const terms = snapshotTerms(definition, {
    issuedAt: at("2027-05-01T09:00"),
  });
  return {
    id: `pass-${identifier.slice(0, 4)}`,
    tenantId: TENANT,
    facilityId: "freibad",
    label: "Saisonkarte · Erwachsene",
    holder: null,
    codeHash: lookupHash(TENANT, identifier),
    retiredCodeHashes: [],
    terms,
    projection: emptyProjection(terms),
    version: 0,
    issuedAt: at("2027-05-01T09:00"),
    ...extra,
  };
}

const qr = (identifier) =>
  payloadOf(tenantKey(SECRET, TENANT), TENANT, identifier);

/** A store with the pool, one season pass, and a service on a set clock. */
function setup({ facility = FACILITY, passes = [passFor(SEASON_ID)] } = {}) {
  const store = new MemoryAdmissionStore();
  store.putFacility(facility);
  passes.forEach((pass) => store.putPass(pass));
  const clock = { now: at("2027-07-01T10:00") };
  let ids = 0;
  const service = new AdmissionCheckService({
    store,
    secret: SECRET,
    now: () => clock.now,
    newId: () => `id-${++ids}`,
  });
  const check = (code, input = {}) =>
    service.check({ tenantId: TENANT, device: GATE, code, ...input });
  return { store, clock, service, check };
}

describe("admission check service", () => {
  it("grants an entry, writes it to the usage log and keeps booking data out of the answer", async () => {
    const { store, check } = setup();

    const answer = await check(qr(SEASON_ID), { scanId: "scan-1" });

    expect(answer).to.deep.include({
      scanId: "scan-1",
      result: R.GRANTED,
      step: null,
      reason: null,
      message: "Eintritt gewährt",
    });
    expect(answer.pass).to.deep.equal({
      id: "pass-7KQ2",
      label: "Saisonkarte · Erwachsene",
      holder: null,
      state: "present",
      validUntil: at("2027-09-16T00:00"),
      quotaLeft: null,
    });
    const log = await store.eventsAfter(TENANT, "pass-7KQ2", 0);
    expect(log.map(({ type, seq, actor }) => [type, seq, actor])).to.deep.equal(
      [[E.ENTRY, 1, { source: "device", deviceId: "gate-1" }]],
    );
    const pass = await store.passById(TENANT, "pass-7KQ2");
    expect(pass.version).to.equal(1);
    expect(pass.projection.presentSince).to.equal(at("2027-07-01T10:00"));
  });

  it("answers a scan sent twice with the first answer and enters once", async () => {
    const { store, clock, check } = setup();

    const first = await check(qr(SEASON_ID), { scanId: "scan-1" });
    clock.now += 4000;
    const again = await check(qr(SEASON_ID), { scanId: "scan-1" });

    expect(again).to.deep.equal(first);
    expect(await store.eventsAfter(TENANT, "pass-7KQ2", 0)).to.have.length(1);
  });

  it("tells a repeated scan to retry while the first is under way, and checks a dead one again", async () => {
    const { store, clock, check } = setup();
    await store.reserveCheck({
      tenantId: TENANT,
      scanId: "scan-1",
      deviceId: "gate-1",
      at: clock.now,
    });

    let refusal;
    try {
      await check(qr(SEASON_ID), { scanId: "scan-1" });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).to.deep.include({
      statusCode: 409,
      code: "scan_in_progress",
    });

    clock.now += PENDING_TIMEOUT_MS;
    const answer = await check(qr(SEASON_ID), { scanId: "scan-1" });
    expect(answer.result).to.equal(R.GRANTED);
  });

  it("lets only one of two devices enter a pass scanned at the same moment", async () => {
    const { store, service } = setup();

    const answers = await Promise.all(
      [GATE, SIDE_GATE].map((device, index) =>
        service.check({
          tenantId: TENANT,
          device,
          code: qr(SEASON_ID),
          scanId: `scan-${index}`,
        }),
      ),
    );

    expect(answers.map((answer) => answer.result).sort()).to.deep.equal([
      R.DENIED,
      R.GRANTED,
    ]);
    expect(
      answers.find((answer) => answer.result === R.DENIED).reason,
    ).to.equal(D.ALREADY_PRESENT);
    expect(await store.eventsAfter(TENANT, "pass-7KQ2", 0)).to.have.length(1);
  });

  it("catches a projection up with an event its writer could not project any more", async () => {
    const { store, check } = setup();
    // A process appended the entry and died before the projection followed.
    store.events.set(`${TENANT}:pass-7KQ2:1`, {
      id: "lost",
      tenantId: TENANT,
      passId: "pass-7KQ2",
      seq: 1,
      type: E.ENTRY,
      at: at("2027-07-01T09:15"),
      day: "2027-07-01",
    });

    const answer = await check(qr(SEASON_ID));

    expect(answer).to.deep.include({
      result: R.DENIED,
      reason: D.ALREADY_PRESENT,
      message: "Bereits eingecheckt seit 09:15, kein Austritt erfasst",
    });
    expect((await store.passById(TENANT, "pass-7KQ2")).version).to.equal(1);
  });

  it("records an exit and answers an exit without presence as such", async () => {
    const { store, clock, check } = setup();
    await check(qr(SEASON_ID));
    clock.now = at("2027-07-01T12:00");

    const out = await check(qr(SEASON_ID), { direction: "exit" });
    const twice = await check(qr(SEASON_ID), { direction: "exit" });

    expect([out.result, twice.result]).to.deep.equal([R.EXITED, R.NOT_PRESENT]);
    const log = await store.eventsAfter(TENANT, "pass-7KQ2", 0);
    expect(log.map((event) => event.type)).to.deep.equal([E.ENTRY, E.EXIT]);
  });

  it("takes the identifier typed by the staff, without a tag", async () => {
    const { check } = setup();

    const answer = await check(formatIdentifier(SEASON_ID).toLowerCase());

    expect(answer.result).to.equal(R.GRANTED);
  });

  it("names a forged tag, a reissued code, an unknown one and the status page", async () => {
    const reissued = passFor(OTHER_ID, SEASON, {
      id: "pass-new",
      codeHash: lookupHash(TENANT, identifierOf("H3W7KQ2M9XD4RTB")),
      retiredCodeHashes: [lookupHash(TENANT, OTHER_ID)],
    });
    const { check } = setup({ passes: [passFor(SEASON_ID), reissued] });
    const forged = qr(SEASON_ID).replace(/.$/, (last) =>
      last === "0" ? "1" : "0",
    );

    const reasons = [];
    for (const code of [
      forged,
      qr(OTHER_ID),
      qr(identifierOf("XXXXXXXXXXXXXXX")),
      "https://booking.example/booking/status/bad-belzig?id=AB12-CD34",
    ]) {
      reasons.push((await check(code)).reason);
    }

    expect(reasons).to.deep.equal([
      D.CODE_NOT_GENUINE,
      D.CODE_REPLACED,
      D.CODE_UNKNOWN,
      D.NOT_A_TICKET,
    ]);
  });

  it("counts refused attempts in the lock period into a notice", async () => {
    const lock = { ...SEASON, lockMinutes: 180 };
    const { clock, check } = setup({ passes: [passFor(SEASON_ID, lock)] });
    await check(qr(SEASON_ID));
    clock.now = at("2027-07-01T10:30");
    await check(qr(SEASON_ID), { direction: "exit" });

    clock.now = at("2027-07-01T10:40");
    const first = await check(qr(SEASON_ID));
    clock.now = at("2027-07-01T10:45");
    const second = await check(qr(SEASON_ID));

    expect(first).to.deep.include({ reason: D.LOCK_PERIOD, notices: [] });
    expect(second.reason).to.equal(D.LOCK_PERIOD);
    expect(second.notices.map((notice) => notice.code)).to.deep.equal([
      N.REPEATED_ATTEMPTS,
    ]);
  });

  it("checks the capacity at entry against the passes present in the facility", async () => {
    const atEntry = { ...SEASON, capacityCheck: "entry" };
    const { check } = setup({
      facility: { ...FACILITY, capacity: 1 },
      passes: [passFor(SEASON_ID, atEntry), passFor(OTHER_ID, atEntry)],
    });

    const first = await check(qr(SEASON_ID));
    const second = await check(qr(OTHER_ID));

    expect(first.result).to.equal(R.GRANTED);
    expect(second).to.deep.include({
      result: R.DENIED,
      reason: D.CAPACITY_REACHED,
      message: "Einrichtung voll: 1 von 1 eingecheckt",
    });
  });

  it("refuses a malformed request and a facility without admission settings", async () => {
    const { check, store } = setup();
    const errors = [];
    for (const input of [
      { direction: "sideways" },
      { scanId: "not a scan id" },
      { code: 42 },
    ]) {
      try {
        await check(qr(SEASON_ID), input);
      } catch (err) {
        errors.push(`${err.statusCode} ${err.code}`);
      }
    }
    store.facilities.clear();
    try {
      await check(qr(SEASON_ID));
    } catch (err) {
      errors.push(`${err.statusCode} ${err.code}`);
    }

    expect(errors).to.deep.equal([
      "400 invalid_direction",
      "400 invalid_scan_id",
      "400 invalid_code",
      "404 admission_facility_not_found",
    ]);
  });

  it("answers 503 on an instance without the code secret and logs no scan", async () => {
    const store = new MemoryAdmissionStore();
    store.putFacility(FACILITY);
    const service = new AdmissionCheckService({ store, secret: undefined });

    let refusal;
    try {
      await service.check({ tenantId: TENANT, device: GATE, code: "x" });
    } catch (err) {
      refusal = err;
    }

    expect(refusal).to.deep.include({
      statusCode: 503,
      code: "admission_not_configured",
    });
    expect(store.checks.size).to.equal(0);
  });
});

describe("admission check service: access log", () => {
  /** A service whose access log keeps its rows, or fails every write. */
  function withAccessLog({ fails = false } = {}) {
    const rows = [];
    const accessLog = {
      async log(entry) {
        if (fails) {
          throw new Error("connection lost");
        }
        rows.push(entry);
      },
    };
    const store = new MemoryAdmissionStore();
    store.putFacility(FACILITY);
    store.putPass(passFor(SEASON_ID, SEASON, { bookingId: "booking-1" }));
    let ids = 0;
    const service = new AdmissionCheckService({
      store,
      secret: SECRET,
      now: () => at("2027-07-01T10:00"),
      newId: () => `id-${++ids}`,
      accessLog,
    });
    const check = (code, input = {}) =>
      service.check({ tenantId: TENANT, device: GATE, code, ...input });
    return { rows, store, check };
  }

  it("writes every check once, at the device's access point, with the booking of the pass", async () => {
    const { rows, check } = withAccessLog();

    await check(qr(SEASON_ID), { scanId: "scan-1" });
    await check(qr(SEASON_ID), { scanId: "scan-1" });
    await check(qr(SEASON_ID), { scanId: "scan-2" });
    await check(qr(OTHER_ID), { scanId: "scan-3" });

    expect(rows).to.have.length(3);
    expect(rows[0]).to.deep.equal({
      tenantId: TENANT,
      bookingId: "booking-1",
      accessPointId: "gate-1",
      accessPointType: "door",
      provider: "admission",
      action: "scan",
      actor: { source: "system" },
      result: "success",
      blockingReasons: [],
      payload: {
        admission: {
          scanId: "scan-1",
          direction: "entry",
          result: R.GRANTED,
          step: null,
          reason: null,
          notices: [],
          passId: "pass-7KQ2",
          facilityId: "freibad",
        },
      },
      errorMessage: null,
      timestamp: at("2027-07-01T10:00"),
    });
    expect(
      rows
        .slice(1)
        .map((row) => [
          row.result,
          row.blockingReasons,
          row.bookingId,
          row.payload.admission.passId,
        ]),
    ).to.deep.equal([
      ["denied", [D.ALREADY_PRESENT], "booking-1", "pass-7KQ2"],
      ["denied", [D.CODE_UNKNOWN], null, null],
    ]);
    expect(rows[1].errorMessage).to.match(/^Bereits eingecheckt seit/);
  });

  it("lets the entrance go on when the access log cannot be written", async () => {
    const { store, check } = withAccessLog({ fails: true });

    const answer = await check(qr(SEASON_ID), { scanId: "scan-1" });

    expect(answer.result).to.equal(R.GRANTED);
    const log = await store.eventsAfter(TENANT, "pass-7KQ2", 0);
    expect(log.map(({ type }) => type)).to.deep.equal([E.ENTRY]);
  });
});
