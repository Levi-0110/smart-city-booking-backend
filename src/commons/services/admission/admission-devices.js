const crypto = require("crypto");

const RateLimiter = require("../rate-limit/rate-limiter");
const { admissionChecksPerDevice } = require("../rate-limit/limits");
const {
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
} = require("../../../errors/BaseError");

/**
 * Devices at the entrances (glossary "Einlassgerät", Pos. 4.2). A device is
 * registered by the administration for one facility and gets a key of 256
 * random bits, shown once; the platform keeps only its hash. The device sends
 * the key as `Authorization: Device <key>`; it is no session and opens
 * nothing but the check of its facility. Each device can be blocked or given
 * a new key on its own; every check is counted against the device's rate
 * limit.
 */

const DEVICE_KEY_PREFIX = "adm_";

const DEVICE_STATUS = Object.freeze({
  ACTIVE: "active",
  BLOCKED: "blocked",
});

/** Seen-at is written at most this often per device. */
const SEEN_INTERVAL_MS = 60 * 1000;

const DEVICE_AUTHORIZATION = /^Device\s+(adm_[A-Za-z0-9_-]{43})$/;

/** A new device key: the prefix and 32 random bytes, base64url. */
function generateDeviceKey() {
  return DEVICE_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** The hash a device key is stored and looked up as, hex. */
function keyHashOf(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * The device key of an `Authorization` header, null for any other header.
 *
 * @param {string|undefined} header
 * @returns {string|null}
 */
function deviceKeyOf(header) {
  const match = DEVICE_AUTHORIZATION.exec(String(header ?? "").trim());
  return match ? match[1] : null;
}

/**
 * A new device for a facility and its key. The key is returned once and
 * never stored.
 *
 * @returns {{ key: string, device: Object }}
 */
function registerDevice({
  tenantId,
  facilityId,
  name,
  createdBy = null,
  now = Date.now(),
  newId = () => crypto.randomUUID(),
}) {
  const key = generateDeviceKey();
  return {
    key,
    device: {
      id: newId(),
      tenantId,
      facilityId,
      name,
      keyHash: keyHashOf(key),
      status: DEVICE_STATUS.ACTIVE,
      createdAt: now,
      createdBy,
      renewedAt: null,
      lastSeenAt: null,
    },
  };
}

/**
 * The same device with a new key; the old key stops working with the save.
 *
 * @returns {{ key: string, device: Object }}
 */
function renewDeviceKey(device, now = Date.now()) {
  const key = generateDeviceKey();
  return {
    key,
    device: { ...device, keyHash: keyHashOf(key), renewedAt: now },
  };
}

/**
 * The express middleware of the device routes: 401 without a valid device
 * key of this tenant, 403 for a blocked device, 429 beyond its rate limit.
 * Hands the device on as `req.admissionDevice`.
 *
 * @param {Object} options
 * @param {Object} options.store An admission store (admission-store.js)
 * @param {{ consume: Function }} [options.limiter=RateLimiter]
 * @param {() => number} [options.now=Date.now]
 * @returns {import("express").RequestHandler}
 */
function deviceAuth({ store, limiter = RateLimiter, now = Date.now }) {
  return async function admissionDeviceAuth(req, res, next) {
    try {
      const key = deviceKeyOf(req.get("authorization"));
      if (!key) {
        throw new UnauthorizedError("device_key_missing");
      }
      const device = await store.deviceByKeyHash(keyHashOf(key));
      if (!device || device.tenantId !== req.params.tenant) {
        throw new UnauthorizedError("device_unknown");
      }
      if (device.status !== DEVICE_STATUS.ACTIVE) {
        throw new ForbiddenError("device_blocked");
      }
      const limit = await limiter.consume(admissionChecksPerDevice(device.id));
      if (!limit.allowed) {
        throw new TooManyRequestsError("too_many_checks", {
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }

      const at = now();
      if (!(device.lastSeenAt > at - SEEN_INTERVAL_MS)) {
        store.touchDevice(device.tenantId, device.id, at).catch(() => {});
      }
      req.admissionDevice = device;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  DEVICE_STATUS,
  DEVICE_KEY_PREFIX,
  generateDeviceKey,
  keyHashOf,
  deviceKeyOf,
  registerDevice,
  renewDeviceKey,
  deviceAuth,
};
