/**
 * Admission on the building blocks of the access subsystem (docs/admission.md,
 * "Devices and the machine access"): the devices are access points of the
 * provider `admission`, their keys the backend-owned state of the tenant's
 * access application `admission`, and every check a row of the access log
 * that the audit export names in words.
 */

const { expect } = require("chai");
const sinon = require("sinon");

require("../src/commons/services/access/providers/register-access-providers");
const {
  hasAccessProvider,
  getAccessProviderCapabilities,
} = require("../src/commons/services/access/providers/access-provider-registry");
const ApplicationFactory = require("../src/commons/entities/application/applicationFactory");
const {
  AdmissionAccessApplication,
} = require("../src/commons/entities/application/accessApplication");
const AccessAppLifecycleService = require("../src/commons/services/access/access-app-lifecycle-service");
const AccessAuditService = require("../src/commons/services/access/access-audit-service");
const AccessLogManager = require("../src/commons/data-managers/access-log-manager");
const { AccessPoint } = require("../src/commons/entities/access/access-point");
const {
  accessPointFieldsOf,
} = require("../src/commons/services/admission/admission-app");
const {
  DENIAL_REASONS,
  ADMISSION_REASON_LABELS,
} = require("../src/commons/services/admission/admission-reasons");

const ENTRY = Object.freeze({
  accessPointId: "gate-1",
  keyHash: "a".repeat(64),
  status: "active",
  createdAt: 1,
  createdBy: "owner-1",
  blockedAt: null,
  blockedBy: null,
  renewedAt: null,
  renewedBy: null,
});

const tenantWith = (deviceKeys, active = true) => ({
  id: "bad-belzig",
  applications: [
    {
      type: "access",
      id: "salto-ks",
      active: true,
      iqActivations: [{ iqId: "iq-1" }],
    },
    { type: "access", id: "admission", active, deviceKeys },
  ],
});

describe("admission on the access subsystem", () => {
  it("registers the provider admission, which declares no capability", () => {
    expect(hasAccessProvider("admission")).to.equal(true);
    expect(getAccessProviderCapabilities("admission")).to.deep.equal([]);
  });

  it("stores a device as a valid access point of the provider", () => {
    const point = AccessPoint.create(
      accessPointFieldsOf({
        id: "gate-1",
        tenantId: "bad-belzig",
        facilityId: "freibad",
        name: "Kasse Nord",
      }),
    );

    expect(point.toResponse()).to.deep.include({
      id: "gate-1",
      provider: "admission",
      type: "door",
      label: "Kasse Nord",
      mode: "authorization",
      config: { facilityId: "freibad" },
      validationRules: [],
    });
    expect(point.toResponse()).to.not.have.property("scanCode");
  });

  it("keeps the device keys of the admission application through the application factory", () => {
    const app = ApplicationFactory.create({
      type: "access",
      id: "admission",
      active: true,
      deviceKeys: [ENTRY],
    });
    app.encrypt();

    expect(app).to.be.instanceOf(AdmissionAccessApplication);
    expect(app.deviceKeys).to.deep.equal([ENTRY]);
  });

  it("restores the stored device keys on a tenant update and never sends them out", () => {
    const stored = tenantWith([ENTRY]);
    const update = tenantWith([{ ...ENTRY, keyHash: "forged" }]);
    delete update.applications[0].iqActivations;

    AccessAppLifecycleService.preserveBackendState(stored, update);
    const answer = AccessAppLifecycleService.redactBackendState(
      structuredClone(update),
    );

    expect(update.applications[1].deviceKeys).to.deep.equal([ENTRY]);
    expect(update.applications[0].iqActivations).to.deep.equal([
      { iqId: "iq-1" },
    ]);
    expect(answer.applications[1]).to.not.have.property("deviceKeys");
    expect(answer.applications[0]).to.not.have.property("iqActivations");
  });

  it("gives a new admission application no device keys from the update", () => {
    const update = tenantWith([ENTRY], false);

    AccessAppLifecycleService.preserveBackendState(
      { applications: [] },
      update,
    );

    expect(update.applications[1].deviceKeys).to.deep.equal([]);
  });

  describe("the audit export of the access log", () => {
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => sandbox.restore());

    it("names every admission reason in words", async () => {
      sandbox.stub(AccessLogManager, "query").resolves([
        {
          action: "scan",
          provider: "admission",
          accessPointId: "gate-1",
          result: "denied",
          blockingReasons: [DENIAL_REASONS.LOCK_PERIOD],
          actor: { source: "system" },
          payload: { admission: { scanId: "scan-1", step: 5 } },
          timestamp: Date.UTC(2027, 6, 1, 8, 0),
        },
      ]);

      const [entry] = await AccessAuditService.getAuditEntries("bad-belzig");

      expect(entry.blockingReasons).to.equal("Sperrzeit");
      expect(Object.keys(ADMISSION_REASON_LABELS)).to.have.members(
        Object.values(DENIAL_REASONS),
      );
    });
  });
});
