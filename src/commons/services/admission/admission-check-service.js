const crypto = require("crypto");

const {
  decide,
  DIRECTION,
  CODE_STATUS,
  ADMISSION_STEPS,
} = require("./admission-check");
const {
  readCode,
  READ_RESULT,
  tenantKey,
  verifyTag,
  lookupHash,
} = require("./admission-code");
const { applyEvent, ACTOR_SOURCES } = require("./admission-state");
const { catchUp, MAX_ATTEMPTS } = require("./admission-log");
const { DENIAL_REASONS } = require("./admission-reasons");
const { CAPACITY_CHECK } = require("./admission-terms");
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} = require("../../../errors/BaseError");

/** A check under way that has not answered for this long counts as dead. */
const PENDING_TIMEOUT_MS = 10 * 1000;

/** The refusals that count as repeated attempts (Pos. 5.5). */
const LOCK_REFUSALS = Object.freeze([
  DENIAL_REASONS.ALREADY_PRESENT,
  DENIAL_REASONS.LOCK_PERIOD,
]);

const SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CODE_LENGTH = 256;
const MIN_SECRET_LENGTH = 32;

/**
 * The admission check behind the route of the devices (Pos. 4.1 to 4.3):
 * resolves the scanned code, loads pass and facility, lets the pure
 * {@link decide} answer and writes the one effect of a granted entry or an
 * exit into the usage log. Every scan, refused or not, is kept in the check
 * log with the answer it got.
 *
 * - A scan sent twice - a device that repeats a request after a timeout -
 *   carries the same `scanId` and gets the first answer again, without a
 *   second entry (Pos. 1.3). While the first is still under way, the second
 *   is told to retry in a second.
 * - Two devices that scan the same pass at the same moment cannot both enter
 *   it: the usage log takes one event per position, the loser checks again
 *   and now sees the pass present.
 * - The answer names the result, the step and the reason in the words of the
 *   staff; it carries no booking, payment or contact data.
 */
class AdmissionCheckService {
  /**
   * @param {Object} options
   * @param {Object} options.store An admission store (admission-store.js)
   * @param {string} [options.secret] The secret the QR tags are derived from,
   *   at least 32 characters; `ADMISSION_CODE_SECRET` by default
   * @param {() => number} [options.now=Date.now]
   * @param {() => string} [options.newId] Ids of events and scans
   */
  constructor({
    store,
    secret = process.env.ADMISSION_CODE_SECRET,
    now = Date.now,
    newId = () => crypto.randomUUID(),
  }) {
    this.store = store;
    this.secret = secret;
    this.now = now;
    this.newId = newId;
  }

  /**
   * Checks one scan of a device.
   *
   * @param {Object} input
   * @param {string} input.tenantId
   * @param {{ id: string, facilityId: string }} input.device The device the
   *   scan came from, authorized before (admission-devices `deviceAuth`)
   * @param {string} input.code What the scanner read or the staff typed
   * @param {string} [input.scanId] The device's id of this scan
   * @param {string} [input.direction=entry] One of {@link DIRECTION}
   * @returns {Promise<Object>} `{ scanId, result, step, reason, message,
   *   notices, pass }`
   */
  async check({ tenantId, device, code, scanId, direction = DIRECTION.ENTRY }) {
    if (!Object.values(DIRECTION).includes(direction)) {
      throw new BadRequestError("invalid_direction");
    }
    if (typeof code !== "string" || code.length > MAX_CODE_LENGTH) {
      throw new BadRequestError("invalid_code");
    }
    if (scanId !== undefined && !SCAN_ID.test(String(scanId))) {
      throw new BadRequestError("invalid_scan_id");
    }
    if (String(this.secret ?? "").length < MIN_SECRET_LENGTH) {
      // An instance without the secret cannot tell a genuine QR code.
      throw new ServiceUnavailableError("admission_not_configured");
    }

    const facility = await this.store.facility(tenantId, device.facilityId);
    if (!facility) {
      throw new NotFoundError("admission_facility_not_found");
    }

    const id = scanId ?? this.newId();
    const begun = this.now();
    const reservation = await this.store.reserveCheck({
      tenantId,
      scanId: id,
      deviceId: device.id,
      facilityId: facility.id,
      direction,
      at: begun,
    });
    if (!reservation.reserved) {
      const earlier = reservation.existing;
      if (earlier.answer) {
        return earlier.answer;
      }
      if (begun - earlier.at < PENDING_TIMEOUT_MS) {
        throw new ConflictError("scan_in_progress", { retryAfterSeconds: 1 });
      }
      // The first attempt died under way: check again under the same scan.
    }

    const { decision, pass } = await this._decideAndWrite({
      tenantId,
      device,
      code,
      direction,
      facility,
    });
    const answer = {
      scanId: id,
      result: decision.result,
      step: decision.step,
      reason: decision.reason,
      message: decision.message,
      notices: decision.notices,
      pass: decision.pass,
    };
    await this.store.completeCheck(tenantId, id, {
      passId: pass?.id ?? null,
      result: decision.result,
      step: decision.step,
      reason: decision.reason,
      answer,
    });
    return answer;
  }

  /** @private */
  async _decideAndWrite({ tenantId, device, code, direction, facility }) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const now = this.now();
      const resolved = await this._resolve(tenantId, code);
      const pass = resolved.pass
        ? await catchUp(this.store, tenantId, resolved.pass)
        : null;

      const needsCount =
        pass &&
        direction === DIRECTION.ENTRY &&
        pass.terms.capacityCheck === CAPACITY_CHECK.ENTRY;
      const input = {
        direction,
        codeStatus: resolved.codeStatus,
        pass,
        facility: {
          ...facility,
          presentCount: needsCount
            ? await this.store.countPresent(tenantId, facility, now)
            : 0,
        },
        now,
      };
      let decision = decide(input);
      // Repeated attempts matter only to a refusal at presence or lock
      // period; only then is the check log asked.
      if (
        decision.step === ADMISSION_STEPS.PRESENCE ||
        decision.step === ADMISSION_STEPS.LOCK_PERIOD
      ) {
        decision = decide({
          ...input,
          history: {
            refusedSinceEntry: await this.store.countRefused(
              tenantId,
              pass.id,
              pass.projection.lastEntryAt,
              LOCK_REFUSALS,
            ),
          },
        });
      }
      if (!decision.effect) {
        return { decision, pass };
      }

      const event = {
        id: this.newId(),
        ...decision.effect,
        actor: { source: ACTOR_SOURCES.DEVICE, deviceId: device.id },
      };
      const projection = applyEvent(pass.projection, event, pass.terms);
      if (await this.store.appendEvent(pass, event, projection)) {
        return { decision, pass };
      }
      // Another device wrote first: look at the pass again.
    }
    throw new ConflictError("admission_check_contended", {
      retryAfterSeconds: 1,
    });
  }

  /**
   * The code as the check knows it: read, its tag verified, the pass looked
   * up by the hash of its identifier. A typed identifier has no tag; its
   * check symbol has vouched for it already.
   *
   * @private
   */
  async _resolve(tenantId, code) {
    const read = readCode(code);
    if (read.kind === READ_RESULT.UNREADABLE) {
      return { codeStatus: CODE_STATUS.UNREADABLE, pass: null };
    }
    if (read.kind === READ_RESULT.NOT_A_TICKET) {
      return { codeStatus: CODE_STATUS.NOT_A_TICKET, pass: null };
    }
    if (
      read.kind === READ_RESULT.PAYLOAD &&
      !verifyTag(
        tenantKey(this.secret, tenantId),
        tenantId,
        read.identifier,
        read.tag,
      )
    ) {
      return { codeStatus: CODE_STATUS.NOT_GENUINE, pass: null };
    }

    const found = await this.store.passByCodeHash(
      tenantId,
      lookupHash(tenantId, read.identifier),
    );
    if (!found) {
      return { codeStatus: CODE_STATUS.UNKNOWN, pass: null };
    }
    if (found.retired) {
      return { codeStatus: CODE_STATUS.REPLACED, pass: null };
    }
    return { codeStatus: CODE_STATUS.FOUND, pass: found.pass };
  }
}

module.exports = {
  AdmissionCheckService,
  PENDING_TIMEOUT_MS,
  LOCK_REFUSALS,
};
