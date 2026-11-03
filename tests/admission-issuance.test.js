const { expect } = require("chai");
const sinon = require("sinon");
const { DateTime } = require("luxon");

const {
  AdmissionIssuanceService,
  hasAdmissionPosition,
} = require("../src/commons/services/admission/admission-issuance");
const {
  AdmissionCheckService,
} = require("../src/commons/services/admission/admission-check-service");
const {
  MemoryAdmissionStore,
} = require("../src/commons/services/admission/admission-store");
const {
  generateIdentifier,
  lookupHash,
  payloadOf,
  tenantKey,
} = require("../src/commons/services/admission/admission-code");
const {
  applyEvent,
  ACTOR_SOURCES,
  USAGE_EVENTS: E,
} = require("../src/commons/services/admission/admission-state");
const {
  ADMISSION_RESULT: R,
  VOID_CAUSES: V,
} = require("../src/commons/services/admission/admission-reasons");
const { appendTo } = require("../src/commons/services/admission/admission-log");
const adapter = require("../src/commons/services/booking-lifecycle/adapters/admission");
const {
  SKIPPED,
} = require("../src/commons/services/booking-lifecycle/pipeline");

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

const SEASON = Object.freeze({
  type: "fixed",
  from: "2027-05-15",
  to: "2027-09-15",
});

function tariff(id, title, admission, relatedBookableIds = ["freibad"]) {
  return { id, type: "ticket", title, relatedBookableIds, admission };
}

const FAMILY = tariff("familie", "Familiensaisonkarte", {
  validity: SEASON,
  usage: { type: "unlimited" },
  lockMinutes: 180,
  bundle: [
    { label: "Erwachsene", count: 2 },
    { label: "Kinder", count: 3 },
  ],
});
const ADULT = tariff("erwachsene", "Saisonkarte Erwachsene", {
  validity: SEASON,
  usage: { type: "unlimited" },
});
const DAY_TICKET = tariff("tageskarte", "Tageskarte", {
  validity: { type: "booking" },
  usage: { type: "single" },
});

const item = (bookable, amount = 1) => ({
  bookableId: bookable.id,
  amount,
  _bookableUsed: bookable,
});

function booking(items, overrides = {}) {
  return {
    id: "B-1",
    tenantId: TENANT,
    status: "confirmed",
    name: "Erika Muster",
    mail: "erika@example.test",
    timeBegin: at("2027-07-01T00:00"),
    timeEnd: at("2027-07-02T00:00"),
    bookableItems: items,
    ...overrides,
  };
}

/** Issuance and check over one store, on one clock; the codes it drew. */
function setup() {
  const store = new MemoryAdmissionStore();
  store.putFacility(FACILITY);
  const clock = { now: at("2027-05-02T10:00") };
  const codes = [];
  let ids = 0;
  const service = new AdmissionIssuanceService({
    store,
    // A stand-in for SecurityUtils: what it seals is not the identifier.
    encrypt: (text) => ({ sealed: [...text].reverse().join("") }),
    now: () => clock.now,
    newId: () => `id-${++ids}`,
    newIdentifier: () => {
      const identifier = generateIdentifier();
      codes.push(identifier);
      return identifier;
    },
  });
  const checks = new AdmissionCheckService({
    store,
    secret: SECRET,
    now: () => clock.now,
  });
  const scan = (identifier, direction = "entry") =>
    checks.check({
      tenantId: TENANT,
      device: GATE,
      code: payloadOf(tenantKey(SECRET, TENANT), TENANT, identifier),
      direction,
    });
  const passes = async () =>
    (await store.passesOfBooking(TENANT, "B-1")).sort(
      (a, b) =>
        a.tariffId.localeCompare(b.tariffId) ||
        a.ticket - b.ticket ||
        a.position - b.position,
    );
  return { store, clock, codes, service, scan, passes };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

describe("admission issuance", () => {
  it("issues one pass per person and booked unit, a ticket per unit, with the terms of the purchase", async () => {
    const { codes, service, passes, clock } = setup();

    const result = await service.issue(booking([item(FAMILY), item(ADULT, 2)]));

    expect(result.issued).to.have.length(7);
    expect(result).to.deep.include({ restored: [], voided: [] });
    const issued = await passes();
    expect(
      issued.map(({ tariffId, ticket, position, label }) => [
        tariffId,
        ticket,
        position,
        label,
      ]),
    ).to.deep.equal([
      ["erwachsene", 1, 1, "Saisonkarte Erwachsene"],
      ["erwachsene", 2, 1, "Saisonkarte Erwachsene"],
      ["familie", 1, 1, "Familiensaisonkarte · Erwachsene"],
      ["familie", 1, 2, "Familiensaisonkarte · Erwachsene"],
      ["familie", 1, 3, "Familiensaisonkarte · Kinder"],
      ["familie", 1, 4, "Familiensaisonkarte · Kinder"],
      ["familie", 1, 5, "Familiensaisonkarte · Kinder"],
    ]);
    for (const pass of issued) {
      expect(pass).to.deep.include({
        facilityId: "freibad",
        bookingId: "B-1",
        holder: null,
        version: 0,
        issuedAt: clock.now,
      });
      expect(pass.terms).to.include({
        validFrom: at("2027-05-15T00:00"),
        validUntil: at("2027-09-16T00:00"),
        lockMinutes: pass.tariffId === "familie" ? 180 : 0,
      });
    }
    // Looked up by hash, kept encrypted, never in clear text; nothing of the booker.
    const hashes = codes.map((code) => lookupHash(TENANT, code));
    expect(issued.map((pass) => pass.codeHash).sort()).to.deep.equal(
      hashes.sort(),
    );
    const stored = JSON.stringify(issued);
    for (const code of codes) {
      expect(stored).not.to.include(code);
    }
    expect(stored).not.to.include("Erika");
  });

  it("lets a pass it issued in at the entrance", async () => {
    const { clock, codes, service, scan } = setup();
    await service.issue(booking([item(ADULT)]));

    clock.now = at("2027-07-01T10:00");
    const answer = await scan(codes[0]);

    expect(answer.result).to.equal(R.GRANTED);
    expect(answer.pass).to.include({
      label: "Saisonkarte Erwachsene",
      state: "present",
    });
  });

  it("issues nothing twice, also when two runs meet", async () => {
    const { store, service } = setup();
    const both = await Promise.all([
      service.issue(booking([item(FAMILY)])),
      service.issue(booking([item(FAMILY)])),
    ]);

    const again = await service.issue(booking([item(FAMILY)]));

    expect(both[0].issued.length + both[1].issued.length).to.equal(5);
    expect(again).to.deep.equal({ issued: [], restored: [], voided: [] });
    expect(store.passes.size).to.equal(5);
  });

  it("voids every pass with the booking and keeps it as proof; the entrance names the cause", async () => {
    const { store, codes, service, scan, passes } = setup();
    await service.issue(booking([item(FAMILY)]));

    const result = await service.void(
      booking([item(FAMILY)]),
      V.BOOKING_CANCELLED,
    );
    const again = await service.void(
      booking([item(FAMILY)]),
      V.BOOKING_CANCELLED,
    );

    expect(result.voided).to.have.length(5);
    expect(again).to.deep.equal({ voided: [] });
    const [first] = await passes();
    const log = await store.eventsAfter(TENANT, first.id, 0);
    expect(
      log.map(({ type, cause, actor }) => [type, cause, actor]),
    ).to.deep.equal([
      [
        E.VOID,
        V.BOOKING_CANCELLED,
        { source: ACTOR_SOURCES.BOOKING, bookingId: "B-1" },
      ],
    ]);
    expect(await scan(codes[0])).to.deep.include({
      result: R.DENIED,
      reason: "voided",
      message: "Ungültig: Buchung storniert",
    });
  });

  it("restores what the booking voided, with the same codes, and leaves a void of the administration", async () => {
    const { store, clock, codes, service, scan, passes } = setup();
    await service.issue(booking([item(ADULT, 2)]));
    const [kept, revoked] = await passes();
    const codeOf = (pass) =>
      codes.find((code) => lookupHash(TENANT, code) === pass.codeHash);
    await appendTo(store, TENANT, revoked.id, () => ({
      id: "by-hand",
      type: E.VOID,
      at: clock.now,
      cause: V.BY_ADMINISTRATION,
      note: "Karte weitergegeben",
      actor: { source: ACTOR_SOURCES.ADMINISTRATION, userId: "admin-1" },
    }));
    await service.void(booking([item(ADULT, 2)]), V.BOOKING_CANCELLED);

    const result = await service.issue(booking([item(ADULT, 2)]));
    clock.now = at("2027-07-01T10:00");

    expect(result).to.deep.equal({
      issued: [],
      restored: [kept.id],
      voided: [],
    });
    expect((await scan(codeOf(kept))).result).to.equal(R.GRANTED);
    expect(await scan(codeOf(revoked))).to.deep.include({
      result: R.DENIED,
      message: "Ungültig: durch die Verwaltung",
    });
  });

  it("follows an amendment: a ticket no longer booked is voided, a tariff booked anew issued", async () => {
    const { store, codes, service, scan, passes } = setup();
    await service.issue(booking([item(ADULT, 2)]));
    const [first, second] = await passes();

    const result = await service.issue(
      booking([item(ADULT, 1), item(DAY_TICKET)]),
    );

    expect(result.issued).to.have.length(1);
    expect(result).to.deep.include({ restored: [], voided: [second.id] });
    expect(await store.eventsAfter(TENANT, first.id, 0)).to.deep.equal([]);
    const day = (await passes()).find((pass) => pass.tariffId === "tageskarte");
    expect(day.terms).to.include({
      validFrom: at("2027-07-01T00:00"),
      validUntil: at("2027-07-02T00:00"),
      usage: "single",
    });
    const secondCode = codes.find(
      (code) => lookupHash(TENANT, code) === second.codeHash,
    );
    expect((await scan(secondCode)).message).to.equal(
      "Ungültig: Buchung geändert",
    );
  });

  it("issues what it can and names each tariff it cannot", async () => {
    const { store, service } = setup();
    const nowhere = tariff("nirgends", "Ohne Einrichtung", ADULT.admission, []);
    const sauna = tariff("sauna-karte", "Sauna", ADULT.admission, ["sauna"]);
    const broken = tariff("kaputt", "Kaputt", {
      validity: SEASON,
      usage: { type: "quota" },
    });

    const err = await rejection(
      service.issue(
        booking([item(ADULT), item(nowhere), item(sauna), item(broken)]),
      ),
    );

    expect(err.message)
      .to.include(
        "tariff nirgends: relates to 0 bookables, not to one facility",
      )
      .and.to.include(
        "tariff sauna-karte: facility sauna has no admission settings",
      )
      .and.to.include("tariff kaputt: admission terms: invalid definition");
    expect(store.passes.size).to.equal(1);
  });

  it("voids even where a device takes the next position of the log first", async () => {
    const { store, service, passes } = setup();
    await service.issue(booking([item(ADULT)]));
    const [pass] = await passes();
    const append = store.appendEvent.bind(store);
    let raced = false;
    store.appendEvent = async (current, event, projection) => {
      if (!raced && event.type === E.VOID) {
        raced = true;
        const entry = {
          id: "entry-1",
          type: E.ENTRY,
          at: at("2027-07-01T10:00"),
          day: "2027-07-01",
          actor: { source: ACTOR_SOURCES.DEVICE, deviceId: "gate-1" },
        };
        await append(
          current,
          entry,
          applyEvent(current.projection, entry, current.terms),
        );
      }
      return append(current, event, projection);
    };

    await service.void(booking([item(ADULT)]), V.BOOKING_CANCELLED);

    const log = await store.eventsAfter(TENANT, pass.id, 0);
    expect(log.map((event) => [event.seq, event.type])).to.deep.equal([
      [1, E.ENTRY],
      [2, E.VOID],
    ]);
    const stored = await store.passById(TENANT, pass.id);
    expect(stored.projection.voided.cause).to.equal(V.BOOKING_CANCELLED);
    expect(stored.projection.presentSince).to.equal(at("2027-07-01T10:00"));
  });

  it("answers nothing for a booking without a tariff of admission, and takes only the booking's causes", async () => {
    const { service } = setup();
    const room = booking([
      { bookableId: "raum", amount: 1, _bookableUsed: { type: "room" } },
    ]);

    expect(hasAdmissionPosition(room)).to.equal(false);
    expect(hasAdmissionPosition(booking([item(ADULT)]))).to.equal(true);
    expect(await service.issue(room)).to.equal(null);
    expect(await service.void(room, V.BOOKING_CANCELLED)).to.equal(null);
    expect(
      (await rejection(service.void(room, V.BY_ADMINISTRATION))).message,
    ).to.include("by_administration is no cause of a booking");
  });
});

describe("the admission adapter of the booking lifecycle", () => {
  afterEach(() => sinon.restore());

  it("hands the booking to the issuance, answers skipped where it has nothing, and keeps to its tenant", async () => {
    const issue = sinon
      .stub(AdmissionIssuanceService.prototype, "issue")
      .onFirstCall()
      .resolves({ issued: ["p-1"], restored: [], voided: [] })
      .onSecondCall()
      .resolves(null);
    const voided = sinon
      .stub(AdmissionIssuanceService.prototype, "void")
      .resolves({ voided: ["p-1"] });
    const paid = booking([item(ADULT)]);

    expect(await adapter.issue(TENANT, paid)).to.deep.equal({
      issued: ["p-1"],
      restored: [],
      voided: [],
    });
    expect(await adapter.issue(TENANT, paid)).to.equal(SKIPPED);
    expect(await adapter.void(TENANT, paid, V.BOOKING_CANCELLED)).to.deep.equal(
      { voided: ["p-1"] },
    );
    expect(voided.firstCall.args).to.deep.equal([paid, V.BOOKING_CANCELLED]);
    expect(
      (await rejection(adapter.issue("another-tenant", paid))).message,
    ).to.include("is not of tenant another-tenant");
    expect(issue.callCount).to.equal(2);
  });
});
