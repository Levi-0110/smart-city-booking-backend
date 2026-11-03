/**
 * The administration of admission (docs/admission.md, "Administration"): the
 * devices at the entrances - registered with a key shown once, blocked and
 * unblocked, given a new key - and the admission settings of the facilities,
 * over the in-memory store and, for the devices, the device middleware of
 * the check route.
 */

const { expect } = require("chai");
const express = require("express");
const request = require("supertest");

const {
  AdmissionAdministrationService,
  settingsFrom,
} = require("../src/commons/services/admission/admission-administration");
const {
  deviceAuth,
  keyHashOf,
} = require("../src/commons/services/admission/admission-devices");
const {
  MemoryAdmissionStore,
} = require("../src/commons/services/admission/admission-store");
const { errorHandler } = require("../src/middleware/error-handler");

const TENANT = "bad-belzig";
const OTHER = "wiesenburg";
const NOW = Date.UTC(2027, 6, 1, 8, 0);
const OWNER = "owner-1";

function setup() {
  const store = new MemoryAdmissionStore();
  store.putFacility({
    tenantId: TENANT,
    id: "freibad",
    capacity: 1200,
    resetTime: "03:00",
    zone: "Europe/Berlin",
  });
  store.putBookable({ tenantId: TENANT, id: "sauna", amount: 40 });
  let ids = 0;
  const admin = new AdmissionAdministrationService({
    store,
    now: () => NOW,
    newId: () => `device-${(ids += 1)}`,
  });

  // The check route as far as the device middleware: it answers who checks.
  const app = express();
  app.post(
    "/api/:tenant/admission/checks",
    deviceAuth({
      store,
      limiter: { consume: async () => ({ allowed: true }) },
      now: () => NOW,
    }),
    (req, res) => res.json({ device: req.admissionDevice.id }),
  );
  app.use(errorHandler);
  const scan = async (key, tenant = TENANT) => {
    const res = await request(app)
      .post(`/api/${tenant}/admission/checks`)
      .set("Authorization", `Device ${key}`);
    return res.status === 200 ? 200 : `${res.status} ${res.body.code}`;
  };
  return { store, admin, scan };
}

/** The error code of a call that must fail. */
async function codeOf(call) {
  try {
    await call;
  } catch (err) {
    return `${err.statusCode} ${err.code}`;
  }
  throw new Error("expected the call to fail");
}

describe("admission administration: devices", () => {
  it("registers a device for a facility with settings and shows its key once", async () => {
    const { store, admin, scan } = setup();

    const { key, device } = await admin.registerDevice(
      TENANT,
      { facilityId: "freibad", name: "  Drehkreuz Nord " },
      { userId: OWNER },
    );

    expect(key).to.match(/^adm_[A-Za-z0-9_-]{43}$/);
    expect(device).to.deep.equal({
      id: "device-1",
      facilityId: "freibad",
      name: "Drehkreuz Nord",
      status: "active",
      createdAt: NOW,
      createdBy: OWNER,
      blockedAt: null,
      blockedBy: null,
      renewedAt: null,
      renewedBy: null,
      lastSeenAt: null,
    });
    expect((await store.deviceById(TENANT, "device-1")).keyHash).to.equal(
      keyHashOf(key),
    );
    const listed = await admin.devices(TENANT);
    expect(listed).to.deep.equal([device]);
    expect(JSON.stringify(listed)).to.not.include(keyHashOf(key));
    expect(await scan(key)).to.equal(200);
  });

  it("refuses a device without a facility with settings, a name or a facility id", async () => {
    const { admin } = setup();
    const register = (input) => codeOf(admin.registerDevice(TENANT, input));

    expect(await register({ facilityId: "sauna", name: "Kasse" })).to.equal(
      "404 admission_facility_not_found",
    );
    expect(await register({ facilityId: "freibad", name: "   " })).to.equal(
      "400 invalid_device_name",
    );
    expect(
      await register({ facilityId: "freibad", name: "x".repeat(81) }),
    ).to.equal("400 invalid_device_name");
    expect(await register({ name: "Kasse" })).to.equal(
      "400 invalid_facility_id",
    );
    expect(await register(undefined)).to.equal("400 invalid_facility_id");
    expect(
      await codeOf(admin.devices(TENANT, { facilityId: ["a", "b"] })),
    ).to.equal("400 invalid_facility_id");
  });

  it("blocks a device at once, leaves the others working and lets the same key back in", async () => {
    const { admin, scan } = setup();
    const north = await admin.registerDevice(TENANT, {
      facilityId: "freibad",
      name: "Nord",
    });
    const south = await admin.registerDevice(TENANT, {
      facilityId: "freibad",
      name: "Süd",
    });

    const blocked = await admin.blockDevice(TENANT, north.device.id, {
      userId: OWNER,
    });
    const again = await admin.blockDevice(TENANT, north.device.id, {
      userId: "someone-else",
    });

    expect(blocked).to.deep.include({
      status: "blocked",
      blockedAt: NOW,
      blockedBy: OWNER,
    });
    expect(again).to.deep.equal(blocked);
    expect(await scan(north.key)).to.equal("403 device_blocked");
    expect(await scan(south.key)).to.equal(200);

    const unblocked = await admin.unblockDevice(TENANT, north.device.id);
    expect(unblocked).to.deep.include({
      status: "active",
      blockedAt: null,
      blockedBy: null,
    });
    expect(await scan(north.key)).to.equal(200);
  });

  it("renews a key: the old one stops, the new one works, a blocked device stays blocked", async () => {
    const { admin, scan } = setup();
    const { key: old, device } = await admin.registerDevice(TENANT, {
      facilityId: "freibad",
      name: "Kasse",
    });

    const renewed = await admin.renewDeviceKey(TENANT, device.id, {
      userId: OWNER,
    });

    expect(renewed.key).to.match(/^adm_/).and.not.equal(old);
    expect(renewed.device).to.deep.include({
      id: device.id,
      renewedAt: NOW,
      renewedBy: OWNER,
    });
    expect(await scan(old)).to.equal("401 device_unknown");
    expect(await scan(renewed.key)).to.equal(200);

    await admin.blockDevice(TENANT, device.id);
    const whileBlocked = await admin.renewDeviceKey(TENANT, device.id);
    expect(whileBlocked.device.status).to.equal("blocked");
    expect(await scan(whileBlocked.key)).to.equal("403 device_blocked");
    expect(await scan(renewed.key)).to.equal("401 device_unknown");
  });

  it("knows no device of another tenant", async () => {
    const { admin, scan } = setup();
    const { key, device } = await admin.registerDevice(TENANT, {
      facilityId: "freibad",
      name: "Kasse",
    });

    for (const call of [
      admin.blockDevice(OTHER, device.id),
      admin.unblockDevice(OTHER, device.id),
      admin.renewDeviceKey(OTHER, device.id),
      admin.blockDevice(TENANT, "unknown"),
    ]) {
      expect(await codeOf(call)).to.equal("404 admission_device_not_found");
    }
    expect(await admin.devices(OTHER)).to.deep.equal([]);
    expect(await scan(key, OTHER)).to.equal("401 device_unknown");
    expect(await scan(key)).to.equal(200);
  });
});

describe("admission administration: facility settings", () => {
  it("keeps the settings whole, with defaults, and leaves the reset mark to the reset", async () => {
    const { store, admin } = setup();

    const saved = await admin.saveFacilitySettings(TENANT, "sauna", {
      resetTime: "06:00",
      zone: "Europe/Berlin",
      maxStayMinutes: 180,
      exitScan: true,
      warnings: { entriesPerDay: 2 },
    });
    await store.markReset(TENANT, "sauna", NOW);
    const replaced = await admin.saveFacilitySettings(TENANT, "sauna", {});

    expect(saved).to.deep.equal({
      facilityId: "sauna",
      resetTime: "06:00",
      zone: "Europe/Berlin",
      maxStayMinutes: 180,
      exitScan: true,
      warnings: { refusedAttempts: 2, entriesPerDay: 2 },
      lastResetAt: null,
    });
    expect(replaced).to.deep.equal({
      facilityId: "sauna",
      resetTime: "03:00",
      zone: "Europe/Berlin",
      maxStayMinutes: null,
      exitScan: false,
      warnings: { refusedAttempts: 2, entriesPerDay: 3 },
      lastResetAt: NOW,
    });
    expect(await admin.facilitySettings(TENANT, "sauna")).to.deep.equal(
      replaced,
    );
    expect(
      (await admin.facilities(TENANT)).map(({ facilityId }) => facilityId),
    ).to.deep.equal(["freibad", "sauna"]);
    // The check reads the same settings, with the capacity of the bookable.
    expect(await store.facility(TENANT, "sauna")).to.deep.include({
      capacity: 40,
      resetTime: "03:00",
      maxStayMinutes: null,
    });
  });

  it("lets a device be registered once its facility has settings", async () => {
    const { admin } = setup();

    await admin.saveFacilitySettings(TENANT, "sauna", { resetTime: "07:00" });
    const { device } = await admin.registerDevice(TENANT, {
      facilityId: "sauna",
      name: "Sauna-Eingang",
    });

    expect(device.facilityId).to.equal("sauna");
    expect(
      (await admin.devices(TENANT, { facilityId: "sauna" })).map(
        ({ id }) => id,
      ),
    ).to.deep.equal([device.id]);
  });

  it("answers settings only for a bookable of the tenant", async () => {
    const { admin } = setup();

    expect(
      await codeOf(admin.saveFacilitySettings(TENANT, "unknown", {})),
    ).to.equal("404 bookable_not_found");
    expect(
      await codeOf(admin.saveFacilitySettings(OTHER, "sauna", {})),
    ).to.equal("404 bookable_not_found");
    expect(await codeOf(admin.facilitySettings(TENANT, "sauna"))).to.equal(
      "404 admission_facility_not_found",
    );
    expect(await admin.facilities(OTHER)).to.deep.equal([]);
  });

  it("refuses settings it cannot keep, naming the field", () => {
    const refused = (body) => {
      try {
        settingsFrom(body);
      } catch (err) {
        return err.code;
      }
      return "kept";
    };

    expect(
      [
        { resetTime: "24:00" },
        { resetTime: "6:00" },
        { resetTime: 600 },
        { zone: "Mars/Olympus" },
        { zone: 1 },
        { maxStayMinutes: 0 },
        { maxStayMinutes: 1441 },
        { maxStayMinutes: 90.5 },
        { maxStayMinutes: "90" },
        { exitScan: "yes" },
        { warnings: { refusedAttempts: 0 } },
        { warnings: { entriesPerDay: 101 } },
        { warnings: [] },
        [],
        null,
        { resetTime: "23:59", zone: "UTC", maxStayMinutes: 1440 },
      ].map(refused),
    ).to.deep.equal([
      "invalid_reset_time",
      "invalid_reset_time",
      "invalid_reset_time",
      "invalid_zone",
      "invalid_zone",
      "invalid_max_stay",
      "invalid_max_stay",
      "invalid_max_stay",
      "invalid_max_stay",
      "invalid_exit_scan",
      "invalid_warnings",
      "invalid_warnings",
      "invalid_warnings",
      "invalid_settings",
      "invalid_settings",
      "kept",
    ]);
  });
});
