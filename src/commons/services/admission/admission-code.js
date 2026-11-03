const crypto = require("crypto");

/**
 * The access identifier of a pass (glossary "Zugangskennung") and the payload
 * of its QR code (Pos. 5.4).
 *
 * The identifier has 16 symbols: 15 drawn from the cryptographic random
 * generator and one check symbol. The ticket prints it in clear text, and the
 * staff types it when a code is damaged (Pos. 4.7), so the alphabet leaves out
 * what is misread or mistyped:
 *
 * - Crockford's base32 already drops I, L, O and U; on input I and L are read
 *   as 1 and O as 0.
 * - Y and Z are dropped as well: a barcode scanner that types into a computer
 *   as a keyboard swaps them when scanner and computer disagree on the layout
 *   (QWERTY against QWERTZ). Digits, the other letters and the dot sit on the
 *   same keys in both layouts.
 *
 * That leaves 30 symbols; the 15 random ones carry 73 bits. The check symbol
 * (Luhn mod 30) catches every single wrong symbol and every swap of two
 * neighbours except `0` with `X`, so a typo is answered as unreadable without
 * a lookup.
 *
 * The QR code adds a tag, `BLT1.<identifier>.<tag>`: an HMAC-SHA-256 over
 * tenant and identifier under the tenant's key. A forged or altered code is
 * told apart from an unknown one before the database is asked. The payload
 * consists of QR alphanumeric characters only, which keeps the code small
 * (version 3 at error correction level Q).
 *
 * The identifier is never stored in clear: a pass is found by its
 * {@link lookupHash}, and the identifier itself is kept encrypted for the
 * re-delivery of a lost ticket (Pos. 5.3).
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWX";
const BASE = ALPHABET.length;
const RANDOM_LENGTH = 15;
const IDENTIFIER_LENGTH = RANDOM_LENGTH + 1;
const TAG_LENGTH = 16;
const PAYLOAD_PREFIX = "BLT1";
const KEY_CONTEXT = "biletado-admission-code";

/** Look-alikes accepted on input, as Crockford's base32 reads them. */
const LOOK_ALIKES = Object.freeze({ I: "1", L: "1", O: "0" });

/** How a scanned or typed text was read. */
const READ_RESULT = Object.freeze({
  /** A QR payload of this module: identifier and tag. */
  PAYLOAD: "payload",
  /** A typed identifier without tag. */
  IDENTIFIER: "identifier",
  /** The QR code or number of the booking confirmation, not a ticket. */
  NOT_A_TICKET: "not_a_ticket",
  /** Nothing this module issued; also a typo the check symbol caught. */
  UNREADABLE: "unreadable",
});

/**
 * Luhn mod N over the symbols, from the right. With `withCheck` the last
 * symbol is a check symbol and is weighted 1, otherwise the next symbol to be
 * appended would be.
 */
function luhnSum(symbols, withCheck) {
  let factor = withCheck ? 1 : 2;
  let sum = 0;
  for (let i = symbols.length - 1; i >= 0; i--) {
    const addend = factor * ALPHABET.indexOf(symbols[i]);
    sum += Math.floor(addend / BASE) + (addend % BASE);
    factor = factor === 2 ? 1 : 2;
  }
  return sum % BASE;
}

/**
 * The check symbol for the 15 random symbols of an identifier.
 *
 * @param {string} body Symbols of {@link ALPHABET}
 * @returns {string} One symbol
 */
function checkSymbolOf(body) {
  return ALPHABET[(BASE - luhnSum(body, false)) % BASE];
}

/**
 * A new identifier from the cryptographic random generator.
 *
 * @returns {string} 16 symbols, unformatted
 */
function generateIdentifier() {
  let body = "";
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    body += ALPHABET[crypto.randomInt(BASE)];
  }
  return body + checkSymbolOf(body);
}

/**
 * Whether a normalized text is an identifier with a matching check symbol.
 *
 * @param {string} identifier
 * @returns {boolean}
 */
function isWellFormed(identifier) {
  return (
    typeof identifier === "string" &&
    identifier.length === IDENTIFIER_LENGTH &&
    [...identifier].every((symbol) => ALPHABET.includes(symbol)) &&
    luhnSum(identifier, true) === 0
  );
}

/**
 * Upper case, without separators and with look-alikes replaced: what the
 * staff typed, ready to be checked.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[ILO]/g, (symbol) => LOOK_ALIKES[symbol]);
}

/**
 * The identifier in four groups for print and display.
 *
 * @param {string} identifier
 * @returns {string} e.g. `7KQ2-M9XD-4RTB-H3WA`
 */
function formatIdentifier(identifier) {
  return identifier.match(/.{1,4}/g).join("-");
}

/**
 * The key a tenant signs its codes with, derived from the instance secret, so
 * that a key never has to be stored per tenant.
 *
 * @param {string|Buffer} secret The instance secret (`ADMISSION_CODE_SECRET`)
 * @param {string} tenantId
 * @returns {Buffer}
 */
function tenantKey(secret, tenantId) {
  if (!secret || String(secret).length < 32) {
    throw new Error("admission code: the secret needs at least 32 characters");
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`${KEY_CONTEXT}:${tenantId}`)
    .digest();
}

/**
 * The tag of an identifier: 16 symbols (78 bits) of its HMAC-SHA-256.
 *
 * @param {Buffer} key See {@link tenantKey}
 * @param {string} tenantId
 * @param {string} identifier
 * @returns {string}
 */
function tagOf(key, tenantId, identifier) {
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${PAYLOAD_PREFIX}.${tenantId}.${identifier}`)
    .digest();
  let value = BigInt(`0x${digest.toString("hex")}`);
  let tag = "";
  for (let i = 0; i < TAG_LENGTH; i++) {
    tag += ALPHABET[Number(value % BigInt(BASE))];
    value /= BigInt(BASE);
  }
  return tag;
}

/**
 * The text the QR code of a ticket carries.
 *
 * @param {Buffer} key See {@link tenantKey}
 * @param {string} tenantId
 * @param {string} identifier
 * @returns {string} `BLT1.<identifier>.<tag>`
 */
function payloadOf(key, tenantId, identifier) {
  return `${PAYLOAD_PREFIX}.${identifier}.${tagOf(key, tenantId, identifier)}`;
}

/**
 * Whether the tag of a payload belongs to the identifier, compared in
 * constant time.
 *
 * @param {Buffer} key See {@link tenantKey}
 * @param {string} tenantId
 * @param {string} identifier
 * @param {string} tag
 * @returns {boolean}
 */
function verifyTag(key, tenantId, identifier, tag) {
  const expected = Buffer.from(tagOf(key, tenantId, identifier));
  const presented = Buffer.from(String(tag ?? ""));
  return (
    expected.length === presented.length &&
    crypto.timingSafeEqual(expected, presented)
  );
}

/**
 * Reads what a scanner sent or the staff typed. Pure and without key: whether
 * a tag is genuine is decided by {@link verifyTag}, whether the identifier is
 * known by the lookup.
 *
 * The confirmation e-mail of a booking carries a QR code of its public status
 * page, and guests show it at the entrance; it is answered as such instead of
 * as unreadable, so the staff can ask for the ticket (Pos. 5.4).
 *
 * @param {string} text The raw scan or typed text
 * @returns {{ kind: string, identifier?: string, tag?: string }}
 *   `kind` is one of {@link READ_RESULT}
 */
function readCode(text) {
  const raw = String(text ?? "").trim();
  if (/\/booking\/status\//i.test(raw)) {
    return { kind: READ_RESULT.NOT_A_TICKET };
  }

  const parts = raw.toUpperCase().split(".");
  if (parts.length === 3 && parts[0] === PAYLOAD_PREFIX) {
    const [, identifier, tag] = parts;
    if (
      isWellFormed(identifier) &&
      tag.length === TAG_LENGTH &&
      [...tag].every((symbol) => ALPHABET.includes(symbol))
    ) {
      return { kind: READ_RESULT.PAYLOAD, identifier, tag };
    }
    return { kind: READ_RESULT.UNREADABLE };
  }

  const identifier = normalize(raw);
  if (isWellFormed(identifier)) {
    return { kind: READ_RESULT.IDENTIFIER, identifier };
  }
  // A booking number has eight symbols; it identifies a booking, not a pass.
  if (/^[0-9A-Z]{8}$/.test(identifier)) {
    return { kind: READ_RESULT.NOT_A_TICKET };
  }
  return { kind: READ_RESULT.UNREADABLE };
}

/**
 * The value a pass is looked up by. Tenant-scoped, so two tenants never
 * collide, and one-way, so a copy of the database holds no usable codes.
 *
 * @param {string} tenantId
 * @param {string} identifier
 * @returns {string} 64 hex characters
 */
function lookupHash(tenantId, identifier) {
  return crypto
    .createHash("sha256")
    .update(`${tenantId}:${identifier}`)
    .digest("hex");
}

module.exports = {
  ALPHABET,
  IDENTIFIER_LENGTH,
  TAG_LENGTH,
  PAYLOAD_PREFIX,
  READ_RESULT,
  checkSymbolOf,
  generateIdentifier,
  isWellFormed,
  normalize,
  formatIdentifier,
  tenantKey,
  tagOf,
  payloadOf,
  verifyTag,
  readCode,
  lookupHash,
};
