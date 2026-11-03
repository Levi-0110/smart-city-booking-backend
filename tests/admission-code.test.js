const { expect } = require("chai");
const QRCode = require("qrcode");

const {
  ALPHABET,
  IDENTIFIER_LENGTH,
  READ_RESULT,
  checkSymbolOf,
  generateIdentifier,
  isWellFormed,
  normalize,
  formatIdentifier,
  tenantKey,
  payloadOf,
  verifyTag,
  readCode,
  lookupHash,
} = require("../src/commons/services/admission/admission-code");

const SECRET = "test-secret-with-at-least-thirty-two-characters";
const TENANT = "bad-belzig";
const KEY = tenantKey(SECRET, TENANT);

/** Identifiers to run the error checks on, fixed so a failure repeats. */
const SAMPLES = [
  "0123456789ABCDE",
  "XXXXXXXXXXXXXXX",
  "7KQ2M9XD4RTBH3W",
  "000000000000000",
  "WVTSRQPNMKJHGFE",
].map((body) => body + checkSymbolOf(body));

describe("admission code", () => {
  describe("identifier", () => {
    it("has 16 symbols of the alphabet and a matching check symbol", () => {
      for (let i = 0; i < 200; i++) {
        const identifier = generateIdentifier();
        expect(identifier).to.have.length(IDENTIFIER_LENGTH);
        expect([...identifier].every((s) => ALPHABET.includes(s))).to.equal(
          true,
        );
        expect(isWellFormed(identifier)).to.equal(true);
      }
    });

    it("does not repeat", () => {
      const identifiers = new Set(
        Array.from({ length: 2000 }, generateIdentifier),
      );
      expect(identifiers.size).to.equal(2000);
    });

    it("leaves out look-alikes and the keys QWERTY and QWERTZ swap", () => {
      expect(ALPHABET).to.have.length(30);
      ["I", "L", "O", "U", "Y", "Z"].forEach((symbol) =>
        expect(ALPHABET).not.to.include(symbol),
      );
    });

    it("catches every single wrong symbol", () => {
      SAMPLES.forEach((identifier) => {
        [...identifier].forEach((original, position) => {
          [...ALPHABET]
            .filter((symbol) => symbol !== original)
            .forEach((symbol) => {
              const typo =
                identifier.slice(0, position) +
                symbol +
                identifier.slice(position + 1);
              expect(isWellFormed(typo), typo).to.equal(false);
            });
        });
      });
    });

    it("catches every swap of two neighbours except 0 with X", () => {
      const missed = [];
      SAMPLES.forEach((identifier) => {
        for (let i = 0; i < identifier.length - 1; i++) {
          const [a, b] = [identifier[i], identifier[i + 1]];
          if (a === b) continue;
          const swapped =
            identifier.slice(0, i) + b + a + identifier.slice(i + 2);
          if (isWellFormed(swapped)) missed.push([a, b].sort().join(""));
        }
      });
      expect([...new Set(missed)]).to.satisfy((pairs) =>
        pairs.every((pair) => pair === "0X"),
      );
    });

    it("reads what the staff types: case, separators and look-alikes", () => {
      expect(normalize(" 7kq2-m9xd 4rtb-h3wa ")).to.equal("7KQ2M9XD4RTBH3WA");
      expect(normalize("I0L1-O")).to.equal("10110");
    });

    it("prints in four groups", () => {
      expect(formatIdentifier("7KQ2M9XD4RTBH3WA")).to.equal(
        "7KQ2-M9XD-4RTB-H3WA",
      );
    });
  });

  describe("QR payload", () => {
    const identifier = SAMPLES[2];
    const payload = payloadOf(KEY, TENANT, identifier);

    it("carries prefix, identifier and tag in QR alphanumeric characters", () => {
      expect(payload).to.match(/^BLT1\.[0-9A-X]{16}\.[0-9A-X]{16}$/);
      expect(payload).to.have.length(38);
    });

    it("fits a version 3 QR code at error correction level Q", () => {
      const qr = QRCode.create(payload, { errorCorrectionLevel: "Q" });
      expect(qr.version).to.be.at.most(3);
      expect(qr.segments.map((segment) => segment.mode.id)).to.deep.equal([
        "Alphanumeric",
      ]);
    });

    it("verifies its own tag only", () => {
      const tag = payload.split(".")[2];
      expect(verifyTag(KEY, TENANT, identifier, tag)).to.equal(true);
      expect(
        verifyTag(tenantKey(SECRET, "other"), "other", identifier, tag),
      ).to.equal(false);
      expect(verifyTag(KEY, TENANT, SAMPLES[0], tag)).to.equal(false);
      const altered = tag.slice(0, -1) + (tag.endsWith("0") ? "1" : "0");
      expect(verifyTag(KEY, TENANT, identifier, altered)).to.equal(false);
      expect(verifyTag(KEY, TENANT, identifier, "short")).to.equal(false);
    });

    it("derives a key per tenant and needs a real secret", () => {
      expect(tenantKey(SECRET, "a").equals(tenantKey(SECRET, "b"))).to.equal(
        false,
      );
      expect(() => tenantKey("too-short", TENANT)).to.throw(/32 characters/);
    });
  });

  describe("readCode", () => {
    const identifier = SAMPLES[2];

    it("reads a scanned payload, also from a scanner with caps lock", () => {
      const payload = payloadOf(KEY, TENANT, identifier);
      expect(readCode(payload)).to.deep.equal({
        kind: READ_RESULT.PAYLOAD,
        identifier,
        tag: payload.split(".")[2],
      });
      expect(readCode(payload.toLowerCase()).kind).to.equal(
        READ_RESULT.PAYLOAD,
      );
    });

    it("reads a typed identifier", () => {
      expect(
        readCode(formatIdentifier(identifier).toLowerCase()),
      ).to.deep.equal({
        kind: READ_RESULT.IDENTIFIER,
        identifier,
      });
    });

    it("answers a typo as unreadable", () => {
      const typo = (identifier[0] === "A" ? "B" : "A") + identifier.slice(1);
      expect(readCode(typo).kind).to.equal(READ_RESULT.UNREADABLE);
    });

    it("tells the booking confirmation and the booking number from a ticket", () => {
      expect(
        readCode(
          "https://buchen.example.org/booking/status/bad-belzig?id=X7&name=Erika",
        ).kind,
      ).to.equal(READ_RESULT.NOT_A_TICKET);
      expect(readCode("K7P2QXRM").kind).to.equal(READ_RESULT.NOT_A_TICKET);
    });

    it("answers anything else as unreadable", () => {
      [
        "",
        "hello",
        "BLT1.SHORT.TAG",
        `BLT1.${identifier}.TOOSHORT`,
        null,
      ].forEach((text) =>
        expect(readCode(text).kind, String(text)).to.equal(
          READ_RESULT.UNREADABLE,
        ),
      );
    });
  });

  describe("lookupHash", () => {
    it("is one-way, deterministic and scoped to the tenant", () => {
      const identifier = SAMPLES[2];
      expect(lookupHash(TENANT, identifier)).to.match(/^[0-9a-f]{64}$/);
      expect(lookupHash(TENANT, identifier)).to.equal(
        lookupHash(TENANT, identifier),
      );
      expect(lookupHash("other", identifier)).not.to.equal(
        lookupHash(TENANT, identifier),
      );
      expect(lookupHash(TENANT, identifier)).not.to.include(
        identifier.toLowerCase(),
      );
    });
  });
});
