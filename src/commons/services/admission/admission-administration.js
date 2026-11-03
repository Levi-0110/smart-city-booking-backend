const crypto = require("crypto");
const { IANAZone } = require("luxon");

const {
  DEVICE_STATUS,
  registerDevice,
  renewDeviceKey,
} = require("./admission-devices");
const { deviceKeyEntryOf } = require("./admission-app");
const { DEFAULT_WARNINGS } = require("./admission-check");
const { FACILITY_DEFAULTS } = require("./admission-store");
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
} = require("../../../errors/BaseError");

/**
 * The administration of admission (Pos. 4.2 to 4.4, 6.1): the devices at the
 * entrances of a tenant and the admission settings of its facilities, behind
 * the administration's routes (`admission.read`, `admission.write`).
 *
 * - A device is registered for one facility that has admission settings, in
 *   a tenant that has the access application `admission`: it becomes an
 *   access point of the provider `admission`, its key an entry of the
 *   application (admission-app.js). The key is in the answer of the
 *   registration and of a renewal, once; the platform keeps only its hash,
 *   and no list or read shows it again. An access point of the provider made
 *   elsewhere has no key until a renewal gives it its first.
 * - Blocking a device stops its checks at once (`403 device_blocked`) and
 *   leaves every other device working; unblocking lets the same key work
 *   again. A renewal gives the device a new key and ends the old one; a
 *   blocked device stays blocked.
 * - The settings of a facility are written whole: a field left out gets its
 *   default. The reset mark (`lastResetAt`) is the daily reset's and is never
 *   written here.
 */

const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 128;
const RESET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A stay ends with its business day anyway. */
const MAX_STAY_LIMIT_MINUTES = 24 * 60;
const MAX_WARNING_THRESHOLD = 100;
/** Attempts at a free device id. */
const MAX_ATTEMPTS = 3;

const DEVICE_FIELDS = Object.freeze([
  "id",
  "facilityId",
  "name",
  "status",
  "createdAt",
  "createdBy",
  "blockedAt",
  "blockedBy",
  "renewedAt",
  "renewedBy",
]);

/** A device as the administration sees it: everything but its key hash. */
function deviceView(device) {
  return Object.fromEntries(
    DEVICE_FIELDS.map((field) => [field, device[field] ?? null]),
  );
}

/** The settings of a facility, with the thresholds of the notices in force. */
function settingsView(settings) {
  return {
    facilityId: settings.facilityId,
    resetTime: settings.resetTime,
    zone: settings.zone,
    maxStayMinutes: settings.maxStayMinutes,
    exitScan: settings.exitScan,
    warnings: { ...DEFAULT_WARNINGS, ...(settings.warnings || {}) },
    lastResetAt: settings.lastResetAt,
  };
}

function idFrom(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new BadRequestError(code);
  }
  return value;
}

function nameFrom(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError("invalid_device_name");
  }
  return name;
}

function warningsFrom(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("invalid_warnings");
  }
  const warnings = {};
  for (const [field, fallback] of Object.entries(DEFAULT_WARNINGS)) {
    const threshold = value[field] ?? fallback;
    if (
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > MAX_WARNING_THRESHOLD
    ) {
      throw new BadRequestError("invalid_warnings", { field });
    }
    warnings[field] = threshold;
  }
  return warnings;
}

/**
 * The settings a request body asks for, each field checked; a field left out
 * gets its default.
 *
 * @param {Object} body `{ resetTime?, zone?, maxStayMinutes?, exitScan?,
 *   warnings? }`
 * @returns {Object} The settings to store
 * @throws {BadRequestError} `invalid_settings`, `invalid_reset_time`,
 *   `invalid_zone`, `invalid_max_stay`, `invalid_exit_scan`,
 *   `invalid_warnings`
 */
function settingsFrom(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("invalid_settings");
  }
  const resetTime = body.resetTime ?? FACILITY_DEFAULTS.resetTime;
  if (typeof resetTime !== "string" || !RESET_TIME.test(resetTime)) {
    throw new BadRequestError("invalid_reset_time");
  }
  const zone = body.zone ?? FACILITY_DEFAULTS.zone;
  if (typeof zone !== "string" || !IANAZone.isValidZone(zone)) {
    throw new BadRequestError("invalid_zone");
  }
  const maxStayMinutes = body.maxStayMinutes ?? null;
  if (
    maxStayMinutes !== null &&
    !(
      Number.isInteger(maxStayMinutes) &&
      maxStayMinutes >= 1 &&
      maxStayMinutes <= MAX_STAY_LIMIT_MINUTES
    )
  ) {
    throw new BadRequestError("invalid_max_stay");
  }
  const exitScan = body.exitScan ?? FACILITY_DEFAULTS.exitScan;
  if (typeof exitScan !== "boolean") {
    throw new BadRequestError("invalid_exit_scan");
  }
  return {
    resetTime,
    zone,
    maxStayMinutes,
    exitScan,
    warnings: warningsFrom(body.warnings),
  };
}

class AdmissionAdministrationService {
  /**
   * @param {Object} options
   * @param {Object} options.store An admission store (admission-store.js)
   * @param {() => number} [options.now=Date.now]
   * @param {() => string} [options.newId] Ids of devices
   */
  constructor({ store, now = Date.now, newId = () => crypto.randomUUID() }) {
    this.store = store;
    this.now = now;
    this.newId = newId;
  }

  /**
   * The devices of the tenant, the oldest first; of one facility where
   * `facilityId` is given.
   *
   * @returns {Promise<Object[]>}
   */
  async devices(tenantId, { facilityId } = {}) {
    const filter =
      facilityId === undefined
        ? {}
        : { facilityId: idFrom(facilityId, "invalid_facility_id") };
    const devices = await this.store.devicesOf(tenantId, filter);
    return devices.map(deviceView);
  }

  /**
   * Registers a device for a facility with admission settings.
   *
   * @param {string} tenantId
   * @param {{ facilityId: string, name: string }} input
   * @param {{ userId?: string|null }} [by] Who registers it
   * @returns {Promise<{ key: string, device: Object }>} The key, shown once
   * @throws {BadRequestError} `invalid_facility_id`, `invalid_device_name`
   * @throws {NotFoundError} `admission_facility_not_found`
   * @throws {ConflictError} `admission_app_missing`
   */
  async registerDevice(tenantId, input, { userId = null } = {}) {
    const facilityId = idFrom(input?.facilityId, "invalid_facility_id");
    const name = nameFrom(input?.name);
    if (!(await this.store.facilitySettings(tenantId, facilityId))) {
      throw new NotFoundError("admission_facility_not_found");
    }
    if (!(await this.store.admissionApp(tenantId))) {
      throw new ConflictError("admission_app_missing");
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const { key, device } = registerDevice({
        tenantId,
        facilityId,
        name,
        createdBy: userId,
        now: this.now(),
        newId: this.newId,
      });
      if (await this.store.insertDevice(device)) {
        return { key, device: deviceView(device) };
      }
    }
    throw new Error(
      `admission administration: no free device id after ${MAX_ATTEMPTS} attempts`,
    );
  }

  /**
   * Blocks a device; a blocked device is answered as it is.
   *
   * @throws {NotFoundError} `admission_device_not_found`
   */
  async blockDevice(tenantId, deviceId, { userId = null } = {}) {
    return this._setStatus(tenantId, deviceId, DEVICE_STATUS.BLOCKED, {
      blockedAt: this.now(),
      blockedBy: userId,
    });
  }

  /**
   * Lets a blocked device check again, with its key as it was.
   *
   * @throws {NotFoundError} `admission_device_not_found`
   */
  async unblockDevice(tenantId, deviceId) {
    return this._setStatus(tenantId, deviceId, DEVICE_STATUS.ACTIVE, {
      blockedAt: null,
      blockedBy: null,
    });
  }

  /**
   * Gives a device a new key; the old one stops working with the save. A
   * device without a key gets its first one.
   *
   * @returns {Promise<{ key: string, device: Object }>} The key, shown once
   * @throws {NotFoundError} `admission_device_not_found`
   * @throws {ConflictError} `admission_app_missing`
   */
  async renewDeviceKey(tenantId, deviceId, { userId = null } = {}) {
    const device = await this._device(tenantId, deviceId);
    const { key, device: renewed } = renewDeviceKey(device, this.now());
    if (device.status === DEVICE_STATUS.NO_KEY) {
      return this._firstKey(tenantId, renewed, key, userId);
    }
    const saved = await this.store.updateDevice(tenantId, device.id, {
      keyHash: renewed.keyHash,
      renewedAt: renewed.renewedAt,
      renewedBy: userId,
    });
    if (!saved) {
      throw new NotFoundError("admission_device_not_found");
    }
    return { key, device: deviceView(saved) };
  }

  /** The settings of the tenant's facilities, by facility id. */
  async facilities(tenantId) {
    const settings = await this.store.facilitySettingsOf(tenantId);
    return settings.map(settingsView);
  }

  /** @throws {NotFoundError} `admission_facility_not_found` */
  async facilitySettings(tenantId, facilityId) {
    const settings = await this.store.facilitySettings(tenantId, facilityId);
    if (!settings) {
      throw new NotFoundError("admission_facility_not_found");
    }
    return settingsView(settings);
  }

  /**
   * Creates or replaces the settings of a facility, a bookable of the tenant.
   *
   * @throws {BadRequestError} See {@link settingsFrom}
   * @throws {NotFoundError} `bookable_not_found`
   */
  async saveFacilitySettings(tenantId, facilityId, body) {
    const settings = settingsFrom(body);
    if (!(await this.store.bookableExists(tenantId, facilityId))) {
      throw new NotFoundError("bookable_not_found");
    }
    const saved = await this.store.saveFacilitySettings(
      tenantId,
      facilityId,
      settings,
    );
    return settingsView(saved);
  }

  /** @private */
  async _device(tenantId, deviceId) {
    const device = await this.store.deviceById(tenantId, deviceId);
    if (!device) {
      throw new NotFoundError("admission_device_not_found");
    }
    return device;
  }

  /** @private The first key of a device that had none. */
  async _firstKey(tenantId, device, key, userId) {
    const entry = deviceKeyEntryOf({
      ...device,
      status: DEVICE_STATUS.ACTIVE,
      createdAt: device.renewedAt,
      createdBy: userId,
      renewedAt: null,
    });
    if (!(await this.store.addDeviceKey(tenantId, entry))) {
      throw new ConflictError("device_key_exists");
    }
    return { key, device: deviceView(await this._device(tenantId, device.id)) };
  }

  /** @private */
  async _setStatus(tenantId, deviceId, status, fields) {
    const device = await this._device(tenantId, deviceId);
    if (device.status === DEVICE_STATUS.NO_KEY) {
      throw new ConflictError("device_without_key");
    }
    if (device.status === status) {
      return deviceView(device);
    }
    const saved = await this.store.updateDevice(tenantId, device.id, {
      status,
      ...fields,
    });
    if (!saved) {
      throw new NotFoundError("admission_device_not_found");
    }
    return deviceView(saved);
  }
}

module.exports = {
  AdmissionAdministrationService,
  settingsFrom,
  deviceView,
};
