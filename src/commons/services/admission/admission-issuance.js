const crypto = require("crypto");

const { passesOf, snapshotTerms } = require("./admission-terms");
const { generateIdentifier, lookupHash } = require("./admission-code");
const {
  emptyProjection,
  USAGE_EVENTS,
  ACTOR_SOURCES,
} = require("./admission-state");
const { VOID_CAUSES, BOOKING_VOID_CAUSES } = require("./admission-reasons");
const { appendTo, MAX_ATTEMPTS } = require("./admission-log");

/**
 * The issuance of passes from a booking (glossary "Zugangsberechtigung";
 * Pos. 2.1, 2.2, 2.4, 6.4): what the ticket positions of a booking issue,
 * and how the passes follow the booking afterwards.
 *
 * A tariff - a bookable of type `ticket` with an `admission` definition,
 * as the booking holds it from its checkout - issues per booked unit one
 * ticket, and under it one pass per person of its bundle. A pass holds one
 * slot of its booking: tariff, ticket, position. It admits to the facility
 * the tariff relates to and keeps the terms of the purchase.
 *
 * - `issue` makes the passes match the booking: it issues the slots that
 *   have no pass, restores the passes the booking had voided - the same
 *   codes work again after a reinstatement - and voids the passes of slots
 *   the booking no longer books (an amendment). A pass voided by the
 *   administration stays void.
 * - `void` ends every pass of the booking with the booking's cause; the
 *   passes and their logs stay as proof (Pos. 6.4).
 *
 * Both are idempotent, so a second run finds nothing to do. Whatever one
 * tariff lacks - a single facility, admission settings, a valid definition -
 * does not hold up the others: what can be issued is, then the call fails
 * and names the rest. The booking lifecycle calls both as its adapter
 * `admission` and records a failure: the booking stays as it is.
 */

/** Whether a bookable, as a booking holds it, is a tariff that issues passes. */
function isAdmissionTariff(bookable) {
  return (
    bookable?.type === "ticket" &&
    bookable.admission !== null &&
    typeof bookable.admission === "object"
  );
}

/**
 * Whether the booking books a tariff that issues passes.
 *
 * @param {Object} booking
 * @returns {boolean}
 */
function hasAdmissionPosition(booking) {
  return (booking?.bookableItems || []).some((item) =>
    isAdmissionTariff(item?._bookableUsed),
  );
}

/** The booked units of a position, at least one. */
function unitsOf(item) {
  const amount = Math.floor(Number(item?.amount));
  return Number.isFinite(amount) && amount > 0 ? amount : 1;
}

/**
 * The slots a booking issues, in the order of its positions: per booked unit
 * of a tariff a ticket, per person of the bundle a position under it. The
 * tickets are numbered per tariff, so an amendment of one position leaves
 * the slots of the others where they were.
 *
 * @param {Object} booking
 * @returns {{ tariff: Object, ticket: number, position: number, person: string|null }[]}
 */
function slotsOf(booking) {
  const slots = [];
  const tickets = new Map();
  for (const item of booking?.bookableItems || []) {
    const tariff = item?._bookableUsed;
    if (!isAdmissionTariff(tariff)) {
      continue;
    }
    for (let unit = 0; unit < unitsOf(item); unit += 1) {
      const ticket = (tickets.get(tariff.id) ?? 0) + 1;
      tickets.set(tariff.id, ticket);
      for (const { label, position } of passesOf(tariff.admission)) {
        slots.push({ tariff, ticket, position, person: label });
      }
    }
  }
  return slots;
}

const slotKey = ({ tariffId, ticket, position }) =>
  `${tariffId}:${ticket}:${position}`;

/** The facility a tariff admits to: the one bookable it relates to. */
function facilityIdOf(tariff) {
  const related = [...new Set(tariff.relatedBookableIds || [])];
  return related.length === 1 ? related[0] : null;
}

class AdmissionIssuanceService {
  /**
   * @param {Object} options
   * @param {Object} options.store The admission store
   * @param {function(string): Object} options.encrypt Encrypts an identifier
   *   for its re-delivery (`SecurityUtils.encrypt`)
   * @param {() => number} [options.now]
   * @param {() => string} [options.newId] Ids of passes and events
   * @param {() => string} [options.newIdentifier] Access identifiers
   */
  constructor({
    store,
    encrypt,
    now = Date.now,
    newId = () => crypto.randomUUID(),
    newIdentifier = generateIdentifier,
  }) {
    if (typeof encrypt !== "function") {
      // The identifier is never stored in clear text.
      throw new Error("admission issuance: needs encrypt for the identifier");
    }
    this.store = store;
    this.encrypt = encrypt;
    this.now = now;
    this.newId = newId;
    this.newIdentifier = newIdentifier;
  }

  /**
   * Makes the passes of a booking match what it books (see the module).
   *
   * @param {Object} booking With `id`, `tenantId`, `bookableItems` and, for
   *   a validity of the booked period, `timeBegin` and `timeEnd`
   * @returns {Promise<{ issued: string[], restored: string[], voided: string[] }|null>}
   *   The ids of the passes changed, null where the booking neither books a
   *   tariff nor holds a pass
   * @throws {Error} After everything else, naming what it could not issue
   */
  async issue(booking) {
    const { tenantId, id: bookingId } = booking;
    const slots = slotsOf(booking);
    const passes = await this.store.passesOfBooking(tenantId, bookingId);
    if (slots.length === 0 && passes.length === 0) {
      return null;
    }

    const issuedAt = this.now();
    const held = new Map(passes.map((pass) => [slotKey(pass), pass]));
    const wanted = new Set();
    const tariffs = new Map();
    const result = { issued: [], restored: [], voided: [] };
    const problems = [];

    for (const slot of slots) {
      const key = slotKey({ tariffId: slot.tariff.id, ...slot });
      wanted.add(key);
      const pass = held.get(key);
      try {
        if (pass) {
          if (await this._restore(tenantId, pass.id, bookingId)) {
            result.restored.push(pass.id);
          }
          continue;
        }
        if (!tariffs.has(slot.tariff.id)) {
          tariffs.set(
            slot.tariff.id,
            await this._prepare(booking, slot.tariff, issuedAt),
          );
        }
        const prepared = tariffs.get(slot.tariff.id);
        if (prepared.problem) {
          continue;
        }
        const inserted = await this._insert(booking, slot, prepared, issuedAt);
        if (inserted) {
          result.issued.push(inserted.id);
        }
      } catch (err) {
        problems.push(`ticket ${key}: ${err.message}`);
      }
    }
    for (const { problem } of tariffs.values()) {
      if (problem) {
        problems.push(problem);
      }
    }

    for (const pass of passes) {
      if (wanted.has(slotKey(pass))) {
        continue;
      }
      try {
        if (
          await this._void(
            tenantId,
            pass.id,
            VOID_CAUSES.BOOKING_CHANGED,
            bookingId,
          )
        ) {
          result.voided.push(pass.id);
        }
      } catch (err) {
        problems.push(`pass ${pass.id}: ${err.message}`);
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `admission issuance: booking ${bookingId}: ${problems.join("; ")}`,
      );
    }
    return result;
  }

  /**
   * Voids every pass of the booking that is not void yet.
   *
   * @param {Object} booking With `id` and `tenantId`
   * @param {string} cause One of the booking's `VOID_CAUSES`
   * @returns {Promise<{ voided: string[] }|null>} The passes voided, null
   *   where the booking holds none
   * @throws {Error} For a cause the booking does not set; after the other
   *   passes, naming a pass it could not void
   */
  async void(booking, cause) {
    if (!BOOKING_VOID_CAUSES.includes(cause)) {
      throw new Error(`admission issuance: ${cause} is no cause of a booking`);
    }
    const { tenantId, id: bookingId } = booking;
    const passes = await this.store.passesOfBooking(tenantId, bookingId);
    if (passes.length === 0) {
      return null;
    }
    const voided = [];
    const problems = [];
    for (const pass of passes) {
      try {
        if (await this._void(tenantId, pass.id, cause, bookingId)) {
          voided.push(pass.id);
        }
      } catch (err) {
        problems.push(`pass ${pass.id}: ${err.message}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `admission issuance: booking ${bookingId}: ${problems.join("; ")}`,
      );
    }
    return { voided };
  }

  /**
   * What the passes of one tariff share: the facility, which must have
   * admission settings, and the terms snapshot in the facility's time zone.
   *
   * @private
   * @returns {Promise<{ facilityId: string, terms: Object }|{ problem: string }>}
   */
  async _prepare(booking, tariff, issuedAt) {
    const facilityId = facilityIdOf(tariff);
    if (!facilityId) {
      return {
        problem: `tariff ${tariff.id}: relates to ${(tariff.relatedBookableIds || []).length} bookables, not to one facility`,
      };
    }
    const facility = await this.store.facility(booking.tenantId, facilityId);
    if (!facility) {
      return {
        problem: `tariff ${tariff.id}: facility ${facilityId} has no admission settings`,
      };
    }
    const bookingPeriod =
      Number.isFinite(booking.timeBegin) && Number.isFinite(booking.timeEnd)
        ? { begin: booking.timeBegin, end: booking.timeEnd }
        : undefined;
    try {
      return {
        facilityId,
        terms: snapshotTerms(tariff.admission, {
          issuedAt,
          bookingPeriod,
          zone: facility.zone,
        }),
      };
    } catch (err) {
      return { problem: `tariff ${tariff.id}: ${err.message}` };
    }
  }

  /**
   * Inserts the pass of a slot. A slot taken in the meantime was issued by a
   * second run for the same booking; its pass stands. A code taken - once in
   * 2^73 - is drawn again.
   *
   * @private
   * @returns {Promise<Object|null>} The pass, null where another run issued it
   */
  async _insert(booking, slot, { facilityId, terms }, issuedAt) {
    const { tenantId, id: bookingId } = booking;
    const key = slotKey({ tariffId: slot.tariff.id, ...slot });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const identifier = this.newIdentifier();
      const pass = {
        id: this.newId(),
        tenantId,
        facilityId,
        tariffId: slot.tariff.id,
        bookingId,
        ticket: slot.ticket,
        position: slot.position,
        label: slot.person
          ? `${slot.tariff.title} · ${slot.person}`
          : slot.tariff.title ?? null,
        holder: null,
        codeHash: lookupHash(tenantId, identifier),
        retiredCodeHashes: [],
        codeCipher: this.encrypt(identifier),
        terms,
        projection: emptyProjection(terms),
        version: 0,
        issuedAt,
      };
      if (await this.store.insertPass(pass)) {
        return pass;
      }
      const passes = await this.store.passesOfBooking(tenantId, bookingId);
      if (passes.some((other) => slotKey(other) === key)) {
        return null;
      }
    }
    throw new Error(`no free code after ${MAX_ATTEMPTS} attempts`);
  }

  /** @private Whether it restored the pass the booking had voided. */
  async _restore(tenantId, passId, bookingId) {
    const event = await appendTo(this.store, tenantId, passId, (pass) =>
      BOOKING_VOID_CAUSES.includes(pass.projection.voided?.cause)
        ? this._event(USAGE_EVENTS.RESTORE, bookingId)
        : null,
    );
    return event !== null;
  }

  /** @private Whether it voided the pass, which was not void. */
  async _void(tenantId, passId, cause, bookingId) {
    const event = await appendTo(this.store, tenantId, passId, (pass) =>
      pass.projection.voided
        ? null
        : { ...this._event(USAGE_EVENTS.VOID, bookingId), cause },
    );
    return event !== null;
  }

  /** @private */
  _event(type, bookingId) {
    return {
      id: this.newId(),
      type,
      at: this.now(),
      actor: { source: ACTOR_SOURCES.BOOKING, bookingId },
    };
  }
}

module.exports = {
  AdmissionIssuanceService,
  isAdmissionTariff,
  hasAdmissionPosition,
  slotsOf,
  facilityIdOf,
};
