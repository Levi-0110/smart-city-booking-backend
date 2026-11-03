/**
 * The routes of the admission administration over the API (docs/admission.md,
 * "Administration"): a device's key is answered once and never cached, the
 * lists never carry it, and a refused setting names its field. Who may call
 * which route is the snapshot's (tests/snapshots/authorization/routes.json).
 */

const { expect } = require("chai");
const sinon = require("sinon");

const {
  installHarness,
  TENANT,
  OWNER,
  ROLE_HOLDER,
} = require("./helpers/booking-lifecycle-harness");
const { installRouteWorld, FIXTURE_ID } = require("./helpers/route-world");

describe("the admission administration routes", function () {
  this.timeout(20000);

  let h;

  before(async function () {
    h = await installHarness();
    installRouteWorld({
      tenantId: TENANT,
      tenant: h.tenant,
      ownerUserId: ROLE_HOLDER,
      bookables: h.bookables,
    });
  });

  after(async function () {
    sinon.restore();
    await h.close();
  });

  const base = `/api/${TENANT}/admission`;

  it("answers a device's key once, never cached, and lists the device without it", async function () {
    const registered = await h
      .api()
      .post(`${base}/devices`)
      .set(h.as(OWNER))
      .send({ facilityId: FIXTURE_ID, name: "Drehkreuz Nord" });
    const { id } = registered.body.device;
    const renewed = await h
      .api()
      .post(`${base}/devices/${id}/renew`)
      .set(h.as(OWNER))
      .send();
    const listed = await h
      .api()
      .get(`${base}/devices?facilityId=${FIXTURE_ID}`)
      .set(h.as(ROLE_HOLDER))
      .send();

    expect(registered.status).to.equal(201);
    expect(registered.headers["cache-control"]).to.equal("no-store");
    expect(registered.body.key).to.match(/^adm_[A-Za-z0-9_-]{43}$/);
    expect(registered.body.device).to.deep.include({
      facilityId: FIXTURE_ID,
      name: "Drehkreuz Nord",
      status: "active",
    });
    expect(renewed.status).to.equal(200);
    expect(renewed.headers["cache-control"]).to.equal("no-store");
    expect(renewed.body.key)
      .to.match(/^adm_/)
      .and.not.equal(registered.body.key);
    expect(listed.status).to.equal(200);
    expect(listed.body.map((device) => device.id)).to.include(id);
    expect(JSON.stringify(listed.body)).to.not.match(/keyHash|adm_/);
  });

  it("keeps the settings of a facility and names a field it refuses", async function () {
    const refused = await h
      .api()
      .put(`${base}/facilities/${FIXTURE_ID}`)
      .set(h.as(OWNER))
      .send({ resetTime: "25:00" });
    const saved = await h
      .api()
      .put(`${base}/facilities/${FIXTURE_ID}`)
      .set(h.as(OWNER))
      .send({ resetTime: "06:00", maxStayMinutes: 240, exitScan: true });
    const read = await h
      .api()
      .get(`${base}/facilities/${FIXTURE_ID}`)
      .set(h.as(ROLE_HOLDER))
      .send();

    expect(refused.status).to.equal(400);
    expect(refused.body).to.include({
      code: "invalid_reset_time",
      statusCode: 400,
    });
    expect(saved.status).to.equal(200);
    expect(saved.body).to.deep.include({
      facilityId: FIXTURE_ID,
      resetTime: "06:00",
      zone: "Europe/Berlin",
      maxStayMinutes: 240,
      exitScan: true,
    });
    expect(read.body).to.deep.equal(saved.body);
  });
});
