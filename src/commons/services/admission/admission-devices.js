const crypto = require("crypto");

const RateLimiter = require("../rate-limit/rate-limiter");
const { admissionChecksPerDevice } = require("../rate-limit/limits");
const { DEVICE_STATUS } = require("./admission-app");
const {
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
} = require("../../../errors/BaseError");

/**
 * Devices at the entrances (glossary "Einlassgerät", Pos. 4.2) and the machine
 * access they check through. A device is an access point of the provider
 * `admission`, registered by the administration for one facility; it
 * authorizes itself through the tenant's access application `admission`,
 * which keeps the hash of its key (admission-app.js). The key has 256 random
 * bits and is shown once. The device sends it as `Authorization: Device
 * <key>` on a token-authorized route, as the access providers authorize
 * their webhooks with the secret of their application; it is no session and
 * opens nothing but the check of its facility. Each device can be blocked or
 * given a new key on its own, the application switched off for all of them;
 * every check is counted against the device's rate limit.
 */

const DEVICE_KEY_PREFIX = "adm_";

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
      blockedAt: null,
      blockedBy: null,
      renewedAt: null,
      renewedBy: null,
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
 * key of this tenant, 403 for a blocked device or a tenant whose admission
 * application is switched off, 429 beyond the device's rate limit. Hands the
 * device on as `req.admissionDevice`.
 *
 * @param {Object} options
 * @param {Object} options.store An admission store (admission-store.js)
 * @param {{ consume: Function }} [options.limiter=RateLimiter]
 * @returns {import("express").RequestHandler}
 */
function deviceAuth({ store, limiter = RateLimiter }) {
  return async function admissionDeviceAuth(req, res, next) {
    try {
      const key = deviceKeyOf(req.get("authorization"));
      if (!key) {
        throw new UnauthorizedError("device_key_missing");
      }
      const device = await store.deviceByKeyHash(
        req.params.tenant,
        keyHashOf(key),
      );
      if (!device) {
        throw new UnauthorizedError("device_unknown");
      }
      if (!device.appActive) {
        throw new ForbiddenError("admission_inactive");
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
