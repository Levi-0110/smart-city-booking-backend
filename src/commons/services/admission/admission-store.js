/**
 * The storage of admission behind one interface, in memory for the tests and
 * in MongoDB for the API (as the scheduler's job stores): passes and their
 * usage log, the check log, the devices at the entrances and the admission
 * settings of the facilities.
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

/** In memory, for the tests: the same answers as the MongoDB store. */
class MemoryAdmissionStore {
  constructor() {
    this.passes = new Map();
    this.events = new Map();
    this.checks = new Map();
    this.devices = new Map();
    this.facilities = new Map();
  }

  /** Test setup: puts a pass, device or facility in place. */
  putPass(pass) {
    this.passes.set(`${pass.tenantId}:${pass.id}`, copy(pass));
  }

  putDevice(device) {
    this.devices.set(device.keyHash, copy(device));
  }

  putFacility(facility) {
    this.facilities.set(`${facility.tenantId}:${facility.id}`, copy(facility));
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
}

module.exports = { MemoryAdmissionStore, MongoAdmissionStore };
