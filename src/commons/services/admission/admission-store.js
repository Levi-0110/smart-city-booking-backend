/**
 * The storage of admission behind one interface, in memory for the tests and
 * in MongoDB for the API (as the scheduler's job stores): passes and their
 * usage log, the check log, the devices at the entrances and the admission
 * settings of the facilities.
 *
 * A pass issued from a booking holds one slot of it - tariff, ticket and
 * position in the bundle - and a slot holds one pass: of two issuances of
 * the same booking at the same moment only one can insert it.
 *
 * The devices and the settings of the facilities are written by the
 * administration (admission-administration.js); the daily reset reads the
 * settings of every tenant and the open presences of a facility
 * (admission-reset-job.js).
 *
 * The usage log is the source of truth of a pass and its own lock: an event
 * is appended at the next position of the pass's log (`seq`, unique per
 * pass), so of two devices that scan the same pass at the same moment only
 * one can append its entry; the other learns that it lost and checks again.
 * The projection on the pass follows the log in a second, conditional write;
 * a projection that fell behind - a process that died between the two writes
 * - is caught up from the log by the next check.
 */

const { businessDayStart } = require("./admission-state");

const DUPLICATE_KEY = 11000;

const MINUTE = 60 * 1000;

/** The epoch ms from which on a presence still counts at `now` (`isPresent`). */
function presenceFloor(facility, now) {
  const dayStart = businessDayStart(now, facility).toMillis();
  const maxStay = facility.maxStayMinutes;
  return maxStay > 0
    ? { dayStart, staySince: now - maxStay * MINUTE }
    : { dayStart, staySince: null };
}

const copy = (value) => (value == null ? value : structuredClone(value));

/** The slot of a booking a pass holds (unique, see the model's index). */
const sameSlot = (a, b) =>
  a.tenantId === b.tenantId &&
  a.bookingId != null &&
  a.bookingId === b.bookingId &&
  a.tariffId === b.tariffId &&
  a.ticket === b.ticket &&
  a.position === b.position;

/** The defaults of the facility settings (admissionFacilitySchema). */
const FACILITY_DEFAULTS = Object.freeze({
  resetTime: "03:00",
  zone: "Europe/Berlin",
  maxStayMinutes: null,
  exitScan: false,
  warnings: null,
  lastResetAt: null,
});

/** The settings of a facility as both stores answer them. */
function settingsOf(record) {
  const settings = { tenantId: record.tenantId, facilityId: record.facilityId };
  for (const [field, fallback] of Object.entries(FACILITY_DEFAULTS)) {
    settings[field] = copy(record[field] ?? fallback);
  }
  return settings;
}

/** In memory, for the tests: the same answers as the MongoDB store. */
class MemoryAdmissionStore {
  constructor() {
    this.passes = new Map();
    this.events = new Map();
    this.checks = new Map();
    this.devices = new Map();
    this.facilities = new Map();
    this.bookables = new Map();
  }

  /** Test setup: puts a pass, device, facility or bookable in place. */
  putPass(pass) {
    this.passes.set(`${pass.tenantId}:${pass.id}`, copy(pass));
  }

  putDevice(device) {
    this.devices.set(device.keyHash, copy(device));
  }

  putFacility(facility) {
    this.facilities.set(`${facility.tenantId}:${facility.id}`, copy(facility));
  }

  /** A bookable a facility's settings may be saved for, with its `amount`. */
  putBookable({ tenantId, id, amount = null }) {
    this.bookables.set(`${tenantId}:${id}`, { amount });
  }

  async passByCodeHash(tenantId, codeHash) {
    for (const pass of this.passes.values()) {
      if (pass.tenantId !== tenantId) continue;
      if (pass.codeHash === codeHash)
        return { pass: copy(pass), retired: false };
      if ((pass.retiredCodeHashes || []).includes(codeHash)) {
        return { pass: copy(pass), retired: true };
      }
    }
    return null;
  }

  async passById(tenantId, passId) {
    return copy(this.passes.get(`${tenantId}:${passId}`) ?? null);
  }

  async passesOfBooking(tenantId, bookingId) {
    return [...this.passes.values()]
      .filter(
        (pass) => pass.tenantId === tenantId && pass.bookingId === bookingId,
      )
      .map(copy);
  }

  async insertPass(pass) {
    const taken = [...this.passes.values()].some(
      (stored) =>
        stored.tenantId === pass.tenantId &&
        (stored.id === pass.id ||
          stored.codeHash === pass.codeHash ||
          sameSlot(stored, pass)),
    );
    if (taken) {
      return false;
    }
    this.putPass(pass);
    return true;
  }

  async appendEvent(pass, event, projection) {
    const seq = pass.version + 1;
    const key = `${pass.tenantId}:${pass.id}:${seq}`;
    if (this.events.has(key)) {
      return false;
    }
    this.events.set(key, {
      ...copy(event),
      tenantId: pass.tenantId,
      passId: pass.id,
      seq,
    });
    await this.saveProjection(pass, projection, seq);
    return true;
  }

  async eventsAfter(tenantId, passId, seq) {
    return [...this.events.values()]
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.passId === passId &&
          event.seq > seq,
      )
      .sort((a, b) => a.seq - b.seq)
      .map(copy);
  }

  async saveProjection(pass, projection, version) {
    const stored = this.passes.get(`${pass.tenantId}:${pass.id}`);
    if (!stored || stored.version !== pass.version) {
      return false;
    }
    stored.projection = copy(projection);
    stored.version = version;
    return true;
  }

  async countPresent(tenantId, facility, now) {
    const { dayStart, staySince } = presenceFloor(facility, now);
    return [...this.passes.values()].filter((pass) => {
      const since = pass.projection?.presentSince;
      return (
        pass.tenantId === tenantId &&
        pass.facilityId === facility.id &&
        since != null &&
        since >= dayStart &&
        (staySince === null || since > staySince)
      );
    }).length;
  }

  async countRefused(tenantId, passId, since, reasons) {
    return [...this.checks.values()].filter(
      (check) =>
        check.tenantId === tenantId &&
        check.passId === passId &&
        check.at > since &&
        reasons.includes(check.reason),
    ).length;
  }

  async reserveCheck(check) {
    const key = `${check.tenantId}:${check.scanId}`;
    const existing = this.checks.get(key);
    if (existing) {
      return { reserved: false, existing: copy(existing) };
    }
    this.checks.set(key, { ...copy(check), answer: null });
    return { reserved: true };
  }

  async completeCheck(tenantId, scanId, fields) {
    const check = this.checks.get(`${tenantId}:${scanId}`);
    Object.assign(check, copy(fields));
  }

  async deviceByKeyHash(keyHash) {
    return copy(this.devices.get(keyHash) ?? null);
  }

  async touchDevice(tenantId, deviceId, at) {
    for (const device of this.devices.values()) {
      if (device.tenantId === tenantId && device.id === deviceId) {
        device.lastSeenAt = at;
      }
    }
  }

  async facility(tenantId, facilityId) {
    return copy(this.facilities.get(`${tenantId}:${facilityId}`) ?? null);
  }

  async devicesOf(tenantId, { facilityId } = {}) {
    return [...this.devices.values()]
      .filter(
        (device) =>
          device.tenantId === tenantId &&
          (facilityId === undefined || device.facilityId === facilityId),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copy);
  }

  async deviceById(tenantId, deviceId) {
    const device = [...this.devices.values()].find(
      (stored) => stored.tenantId === tenantId && stored.id === deviceId,
    );
    return copy(device ?? null);
  }

  /** False where the id (in the tenant) or the key hash is taken. */
  async insertDevice(device) {
    const taken =
      this.devices.has(device.keyHash) ||
      [...this.devices.values()].some(
        (stored) =>
          stored.tenantId === device.tenantId && stored.id === device.id,
      );
    if (taken) {
      return false;
    }
    this.putDevice(device);
    return true;
  }

  /** The device with `fields` set, null where the tenant has no such device. */
  async updateDevice(tenantId, deviceId, fields) {
    const device = await this.deviceById(tenantId, deviceId);
    if (!device) {
      return null;
    }
    this.devices.delete(device.keyHash);
    const updated = { ...device, ...copy(fields) };
    this.putDevice(updated);
    return copy(updated);
  }

  async facilitySettingsOf(tenantId) {
    return [...this.facilities.values()]
      .filter((record) => record.tenantId === tenantId)
      .map((record) => settingsOf({ ...record, facilityId: record.id }))
      .sort((a, b) => a.facilityId.localeCompare(b.facilityId));
  }

  async facilitySettings(tenantId, facilityId) {
    const record = this.facilities.get(`${tenantId}:${facilityId}`);
    return record ? settingsOf({ ...record, facilityId }) : null;
  }

  /** Creates or replaces the settings; the reset mark stays as it was. */
  async saveFacilitySettings(tenantId, facilityId, settings) {
    const key = `${tenantId}:${facilityId}`;
    const record = {
      tenantId,
      id: facilityId,
      capacity: this.bookables.get(key)?.amount ?? null,
      ...this.facilities.get(key),
      ...copy(settings),
    };
    this.facilities.set(key, record);
    return settingsOf({ ...record, facilityId });
  }

  async bookableExists(tenantId, bookableId) {
    const key = `${tenantId}:${bookableId}`;
    return this.bookables.has(key) || this.facilities.has(key);
  }

  /** The settings of the facilities of every tenant, for the daily reset. */
  async allFacilitySettings() {
    return [...this.facilities.values()].map((record) =>
      settingsOf({ ...record, facilityId: record.id }),
    );
  }

  async openPresences(tenantId, facilityId) {
    return [...this.passes.values()]
      .filter(
        (pass) =>
          pass.tenantId === tenantId &&
          pass.facilityId === facilityId &&
          pass.projection?.presentSince != null,
      )
      .map((pass) => ({
        passId: pass.id,
        presentSince: pass.projection.presentSince,
      }));
  }

  /** Moves the facility's reset mark forward, never back. */
  async markReset(tenantId, facilityId, upTo) {
    const record = this.facilities.get(`${tenantId}:${facilityId}`);
    if (record && !(record.lastResetAt >= upTo)) {
      record.lastResetAt = upTo;
    }
  }
}

/** In MongoDB, for the API. The models are injectable for the tests. */
class MongoAdmissionStore {
  constructor(models = {}) {
    this.models = models;
  }

  /** @private The model of `name`, loaded on first use. */
  model(name) {
    if (!this.models[name]) {
      const files = {
        passes: "admissionPassModel",
        events: "admissionEventModel",
        checks: "admissionCheckModel",
        devices: "admissionDeviceModel",
        facilities: "admissionFacilityModel",
        bookables: "bookableModel",
      };
      this.models[name] = require(`../../data-managers/models/${files[name]}`);
    }
    return this.models[name];
  }

  async passByCodeHash(tenantId, codeHash) {
    const passes = this.model("passes");
    const pass = await passes.findOne({ tenantId, codeHash }).lean();
    if (pass) {
      return { pass, retired: false };
    }
    const retired = await passes
      .findOne({ tenantId, retiredCodeHashes: codeHash })
      .lean();
    return retired ? { pass: retired, retired: true } : null;
  }

  async passById(tenantId, passId) {
    return await this.model("passes").findOne({ tenantId, id: passId }).lean();
  }

  async passesOfBooking(tenantId, bookingId) {
    return await this.model("passes").find({ tenantId, bookingId }).lean();
  }

  /** False where the id, the code or the slot is taken. */
  async insertPass(pass) {
    try {
      await this.model("passes").create(pass);
      return true;
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) {
        return false;
      }
      throw err;
    }
  }

  async appendEvent(pass, event, projection) {
    const seq = pass.version + 1;
    try {
      await this.model("events").create({
        ...event,
        tenantId: pass.tenantId,
        passId: pass.id,
        seq,
      });
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) {
        return false;
      }
      throw err;
    }
    await this.saveProjection(pass, projection, seq);
    return true;
  }

  async eventsAfter(tenantId, passId, seq) {
    return await this.model("events")
      .find({ tenantId, passId, seq: { $gt: seq } })
      .sort({ seq: 1 })
      .lean();
  }

  async saveProjection(pass, projection, version) {
    const res = await this.model("passes").updateOne(
      { tenantId: pass.tenantId, id: pass.id, version: pass.version },
      { $set: { projection, version } },
    );
    return res.matchedCount === 1;
  }

  async countPresent(tenantId, facility, now) {
    const { dayStart, staySince } = presenceFloor(facility, now);
    const presentSince = { $gte: dayStart };
    if (staySince !== null) {
      presentSince.$gt = staySince;
    }
    return await this.model("passes").countDocuments({
      tenantId,
      facilityId: facility.id,
      "projection.presentSince": presentSince,
    });
  }

  async countRefused(tenantId, passId, since, reasons) {
    return await this.model("checks").countDocuments({
      tenantId,
      passId,
      at: { $gt: since },
      reason: { $in: reasons },
    });
  }

  async reserveCheck(check) {
    try {
      await this.model("checks").create({ ...check, answer: null });
      return { reserved: true };
    } catch (err) {
      if (err?.code !== DUPLICATE_KEY) {
        throw err;
      }
      const existing = await this.model("checks")
        .findOne({ tenantId: check.tenantId, scanId: check.scanId })
        .lean();
      return { reserved: false, existing };
    }
  }

  async completeCheck(tenantId, scanId, fields) {
    await this.model("checks").updateOne(
      { tenantId, scanId },
      { $set: fields },
    );
  }

  async deviceByKeyHash(keyHash) {
    return await this.model("devices").findOne({ keyHash }).lean();
  }

  async touchDevice(tenantId, deviceId, at) {
    await this.model("devices").updateOne(
      { tenantId, id: deviceId },
      { $set: { lastSeenAt: at } },
    );
  }

  /** The settings of the facility with the capacity of its bookable. */
  async facility(tenantId, facilityId) {
    const [settings, bookable] = await Promise.all([
      this.model("facilities").findOne({ tenantId, facilityId }).lean(),
      this.model("bookables")
        .findOne({ tenantId, id: facilityId })
        .select("amount")
        .lean(),
    ]);
    if (!settings || !bookable) {
      return null;
    }
    return {
      id: facilityId,
      capacity: bookable.amount ?? null,
      resetTime: settings.resetTime,
      zone: settings.zone,
      maxStayMinutes: settings.maxStayMinutes,
      exitScan: settings.exitScan,
      warnings: settings.warnings,
      lastResetAt: settings.lastResetAt,
    };
  }

  async devicesOf(tenantId, { facilityId } = {}) {
    const filter =
      facilityId === undefined ? { tenantId } : { tenantId, facilityId };
    return await this.model("devices")
      .find(filter)
      .sort({ createdAt: 1 })
      .lean();
  }

  async deviceById(tenantId, deviceId) {
    return await this.model("devices")
      .findOne({ tenantId, id: deviceId })
      .lean();
  }

  /** False where the id (in the tenant) or the key hash is taken. */
  async insertDevice(device) {
    try {
      await this.model("devices").create(device);
      return true;
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) {
        return false;
      }
      throw err;
    }
  }

  /** The device with `fields` set, null where the tenant has no such device. */
  async updateDevice(tenantId, deviceId, fields) {
    return await this.model("devices")
      .findOneAndUpdate(
        { tenantId, id: deviceId },
        { $set: fields },
        { new: true },
      )
      .lean();
  }

  async facilitySettingsOf(tenantId) {
    const records = await this.model("facilities")
      .find({ tenantId })
      .sort({ facilityId: 1 })
      .lean();
    return records.map(settingsOf);
  }

  async facilitySettings(tenantId, facilityId) {
    const record = await this.model("facilities")
      .findOne({ tenantId, facilityId })
      .lean();
    return record ? settingsOf(record) : null;
  }

  /** Creates or replaces the settings; the reset mark stays as it was. */
  async saveFacilitySettings(tenantId, facilityId, settings) {
    const record = await this.model("facilities")
      .findOneAndUpdate(
        { tenantId, facilityId },
        { $set: settings },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean();
    return settingsOf(record);
  }

  async bookableExists(tenantId, bookableId) {
    return Boolean(
      await this.model("bookables").exists({ tenantId, id: bookableId }),
    );
  }

  /** The settings of the facilities of every tenant, for the daily reset. */
  async allFacilitySettings() {
    const records = await this.model("facilities").find({}).lean();
    return records.map(settingsOf);
  }

  async openPresences(tenantId, facilityId) {
    const passes = await this.model("passes")
      .find({ tenantId, facilityId, "projection.presentSince": { $ne: null } })
      .select({ id: 1, "projection.presentSince": 1 })
      .lean();
    return passes.map((pass) => ({
      passId: pass.id,
      presentSince: pass.projection.presentSince,
    }));
  }

  /** Moves the facility's reset mark forward, never back. */
  async markReset(tenantId, facilityId, upTo) {
    await this.model("facilities").updateOne(
      { tenantId, facilityId },
      { $max: { lastResetAt: upTo } },
    );
  }
}

module.exports = {
  MemoryAdmissionStore,
  MongoAdmissionStore,
  FACILITY_DEFAULTS,
};
