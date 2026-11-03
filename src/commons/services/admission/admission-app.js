/**
 * Where admission meets the access subsystem (Pos. 4.2, glossary
 * "Einlassgerät"). A device at an entrance is an access point of the provider
 * `admission`; it checks through the machine access of the tenant's access
 * application `admission`, which holds one entry per device in `deviceKeys`:
 * the SHA-256 hash of its key and its status. No other credential exists for
 * a device.
 *
 * The entries are backend-owned state of the application, like the Salto KS
 * IQ activations: only the administration of admission writes them, a tenant
 * update keeps what is stored ({@link preserveDeviceKeys}) and no tenant
 * answer carries them, not even as hashes ({@link redactDeviceKeys}).
 */

/** The provider of the access points that are devices at the entrances. */
const ADMISSION_PROVIDER = "admission";

/** The access application a tenant switches admission on with. */
const ADMISSION_APP = Object.freeze({ type: "access", id: ADMISSION_PROVIDER });

/** The array filter that picks the admission application of a tenant. */
const ADMISSION_APP_FILTER = Object.freeze({
  "app.type": ADMISSION_APP.type,
  "app.id": ADMISSION_APP.id,
});

/** Where a device stands. */
const DEVICE_STATUS = Object.freeze({
  ACTIVE: "active",
  BLOCKED: "blocked",
  /** An access point of the provider that has not been given a key yet. */
  NO_KEY: "no_key",
});

/** The fields of an entry in `deviceKeys`. */
const DEVICE_KEY_FIELDS = Object.freeze([
  "accessPointId",
  "keyHash",
  "status",
  "createdAt",
  "createdBy",
  "blockedAt",
  "blockedBy",
  "renewedAt",
  "renewedBy",
]);

/**
 * The admission application of a tenant, active or not, null without one.
 *
 * @param {Object|null} tenant A tenant with its `applications`
 * @returns {Object|null}
 */
function admissionAppOf(tenant) {
  return (
    (tenant?.applications || []).find(
      (app) => app?.type === ADMISSION_APP.type && app?.id === ADMISSION_APP.id,
    ) ?? null
  );
}

/**
 * Keeps the device keys out of a tenant update's hands: whatever the admin UI
 * round-trips or drops is replaced by what is stored.
 *
 * @param {Object|null} previousTenant The stored tenant
 * @param {Object} nextTenant The tenant about to be stored, mutated
 * @returns {Object} `nextTenant`
 */
function preserveDeviceKeys(previousTenant, nextTenant) {
  const nextApp = admissionAppOf(nextTenant);
  if (nextApp) {
    const stored = admissionAppOf(previousTenant)?.deviceKeys;
    nextApp.deviceKeys = Array.isArray(stored) ? stored : [];
  }
  return nextTenant;
}

/**
 * Removes the device keys from a tenant that is about to leave through the
 * API.
 *
 * @param {Object|null} tenant The tenant answer, mutated
 * @returns {Object|null} `tenant`
 */
function redactDeviceKeys(tenant) {
  const app = admissionAppOf(tenant);
  if (app) {
    delete app.deviceKeys;
  }
  return tenant;
}

/**
 * A device as admission works with it: its access point joined with its
 * entry in the admission application. A point without an entry has no key
 * yet; `appActive` says whether the tenant has admission switched on.
 *
 * @param {Object} point The access point (provider `admission`)
 * @param {Object|null} entry Its entry in `deviceKeys`
 * @param {boolean} appActive
 * @returns {Object}
 */
function deviceOf(point, entry, appActive) {
  return {
    id: point.id,
    tenantId: point.tenantId,
    facilityId: point.config?.facilityId ?? null,
    name: point.label ?? "",
    keyHash: entry?.keyHash ?? null,
    status: entry?.status ?? DEVICE_STATUS.NO_KEY,
    createdAt: entry?.createdAt ?? null,
    createdBy: entry?.createdBy ?? null,
    blockedAt: entry?.blockedAt ?? null,
    blockedBy: entry?.blockedBy ?? null,
    renewedAt: entry?.renewedAt ?? null,
    renewedBy: entry?.renewedBy ?? null,
    appActive: appActive === true,
  };
}

/**
 * The entry a device is stored with in `deviceKeys`.
 *
 * @param {Object} device A device as {@link deviceOf} or `registerDevice`
 *   answers it
 * @returns {Object}
 */
function deviceKeyEntryOf(device) {
  return {
    accessPointId: device.id,
    keyHash: device.keyHash,
    status: device.status,
    createdAt: device.createdAt ?? null,
    createdBy: device.createdBy ?? null,
    blockedAt: device.blockedAt ?? null,
    blockedBy: device.blockedBy ?? null,
    renewedAt: device.renewedAt ?? null,
    renewedBy: device.renewedBy ?? null,
  };
}

/**
 * The access point a new device is stored as: a door of the provider
 * `admission` with its facility in `config`. It carries no validation rules,
 * since nobody opens it; its scan code is never printed.
 *
 * @param {Object} device `{ id, tenantId, facilityId, name }`
 * @returns {Object} The fields for `AccessPoint.create`
 */
function accessPointFieldsOf(device) {
  return {
    id: device.id,
    tenantId: device.tenantId,
    type: "door",
    provider: ADMISSION_PROVIDER,
    label: device.name,
    mode: "authorization",
    config: { facilityId: device.facilityId },
    validationRules: [],
  };
}

module.exports = {
  ADMISSION_PROVIDER,
  ADMISSION_APP,
  ADMISSION_APP_FILTER,
  DEVICE_STATUS,
  DEVICE_KEY_FIELDS,
  admissionAppOf,
  preserveDeviceKeys,
  redactDeviceKeys,
  deviceOf,
  deviceKeyEntryOf,
  accessPointFieldsOf,
};
