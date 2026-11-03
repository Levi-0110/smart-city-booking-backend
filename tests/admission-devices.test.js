const { expect } = require("chai");
const express = require("express");
const request = require("supertest");

const {
  DEVICE_STATUS,
  deviceKeyOf,
  keyHashOf,
  registerDevice,
  renewDeviceKey,
  deviceAuth,
} = require("../src/commons/services/admission/admission-devices");
const {
  MemoryAdmissionStore,
} = require("../src/commons/services/admission/admission-store");
const { errorHandler } = require("../src/middleware/error-handler");

const TENANT = "bad-belzig";
const NOW = Date.UTC(2027, 6, 1, 8, 0);

/** An app with the device middleware in front of a route that names the device. */
function setup({ allowed = true } = {}) {
  const store = new MemoryAdmissionStore();
  const limiter = {
    calls: [],
    async consume(limit) {
      this.calls.push(limit);
      return allowed
        ? { allowed: true, retryAfterSeconds: 0 }
        : { allowed: false, retryAfterSeconds: 17 };
    },
  };
  const app = express();
  app.post(
    "/api/:tenant/admission/checks",
    deviceAuth({ store, limiter, now: () => NOW }),
    (req, res) => res.json({ device: req.admissionDevice.id }),
  );
  app.use(errorHandler);

  const register = (extra = {}) => {
    const { key, device } = registerDevice({
      tenantId: TENANT,
      facilityId: "freibad",
      name: "Kasse Nord",
      now: NOW,
      newId: () => "gate-1",
    });
    store.putDevice({ ...device, ...extra });
    return key;
  };
  const post = (authorization) => {
    const call = request(app).post(`/api/${TENANT}/admission/checks`);
    return authorization ? call.set("Authorization", authorization) : call;
  };
  return { store, limiter, register, post };
}

describe("admission devices", () => {
  it("makes a key of 256 random bits that only its hash is kept of", () => {
    const { key, device } = registerDevice({
      tenantId: TENANT,
      facilityId: "freibad",
      name: "Kasse Nord",
    });

    expect(key).to.match(/^adm_[A-Za-z0-9_-]{43}$/);
    expect(device.keyHash).to.equal(keyHashOf(key)).and.to.have.length(64);
    expect(JSON.stringify(device)).to.not.include(key.slice(4));
    expect(device.status).to.equal(DEVICE_STATUS.ACTIVE);
  });

  it("renews a key so the old one no longer matches", () => {
    const { key, device } = registerDevice({
      tenantId: TENANT,
      facilityId: "freibad",
      name: "Kasse Nord",
    });
    const renewed = renewDeviceKey(device, NOW);

    expect(renewed.key).to.not.equal(key);
    expect(renewed.device.keyHash).to.not.equal(keyHashOf(key));
    expect(renewed.device).to.deep.include({ id: device.id, renewedAt: NOW });
  });

  it("reads a device key only from a Device authorization", () => {
    const key = `adm_${"A".repeat(43)}`;

    expect(deviceKeyOf(`Device ${key}`)).to.equal(key);
    expect(deviceKeyOf(`Bearer ${key}`)).to.equal(null);
    expect(deviceKeyOf(`Device ${key}x`)).to.equal(null);
    expect(deviceKeyOf(undefined)).to.equal(null);
  });

  it("lets a registered device of the tenant through and notes when it was seen", async () => {
    const { store, limiter, register, post } = setup();
    const key = register();

    const res = await post(`Device ${key}`);

    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ device: "gate-1" });
    expect(limiter.calls[0].key).to.equal("admission:device:gate-1");
    expect((await store.deviceByKeyHash(keyHashOf(key))).lastSeenAt).to.equal(
      NOW,
    );
  });

  it("refuses without a key, with a session token and with an unknown key", async () => {
    const { register, post } = setup();
    register();

    const answers = await Promise.all([
      post(),
      post("Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln"),
      post(`Device adm_${"B".repeat(43)}`),
    ]);

    expect(answers.map((res) => [res.status, res.body.code])).to.deep.equal([
      [401, "device_key_missing"],
      [401, "device_key_missing"],
      [401, "device_unknown"],
    ]);
  });

  it("refuses the device of another tenant and a blocked device", async () => {
    const other = setup();
    const keyOfOther = other.register({ tenantId: "wiesenburg" });
    const blocked = setup();
    const keyOfBlocked = blocked.register({ status: DEVICE_STATUS.BLOCKED });

    const fromOther = await other.post(`Device ${keyOfOther}`);
    const fromBlocked = await blocked.post(`Device ${keyOfBlocked}`);

    expect([fromOther.status, fromOther.body.code]).to.deep.equal([
      401,
      "device_unknown",
    ]);
    expect([fromBlocked.status, fromBlocked.body.code]).to.deep.equal([
      403,
      "device_blocked",
    ]);
  });

  it("answers 429 with Retry-After beyond the device's rate limit", async () => {
    const { register, post } = setup({ allowed: false });
    const key = register();

    const res = await post(`Device ${key}`);

    expect(res.status).to.equal(429);
    expect(res.body.code).to.equal("too_many_checks");
    expect(res.headers["retry-after"]).to.equal("17");
  });
});
