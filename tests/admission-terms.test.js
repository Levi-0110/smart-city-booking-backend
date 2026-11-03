const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  problemsOf,
  passesOf,
  snapshotTerms,
  describe: describeTerms,
} = require("../src/commons/services/admission/admission-terms");

const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

const SEASON = Object.freeze({
  validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
  usage: { type: "unlimited" },
  lockMinutes: 180,
});

describe("admission terms", () => {
  describe("problemsOf", () => {
    it("accepts the tariffs of a public pool", () => {
      const tariffs = [
        { ...SEASON },
        { ...SEASON, usage: { type: "quota", quota: 10 } },
        { validity: { type: "booking" }, usage: { type: "single" } },
        {
          validity: { type: "relative", months: 12 },
          usage: { type: "unlimited" },
        },
        {
          ...SEASON,
          personal: { required: true, photo: true },
          bundle: [
            { label: "Erwachsene", count: 2 },
            { label: "Kinder", count: 3 },
          ],
          capacityCheck: "entry",
        },
      ];
      tariffs.forEach((tariff) => expect(problemsOf(tariff)).to.deep.equal([]));
    });

    const cases = [
      ["no definition", undefined, "admission", "missing"],
      [
        "an unknown validity",
        { ...SEASON, validity: { type: "always" } },
        "validity.type",
        "unknown",
      ],
      [
        "a window that ends before it starts",
        {
          ...SEASON,
          validity: { type: "fixed", from: "2027-09-15", to: "2027-05-15" },
        },
        "validity.to",
        "before_from",
      ],
      [
        "a malformed date",
        {
          ...SEASON,
          validity: { type: "fixed", from: "15.05.2027", to: "2027-09-15" },
        },
        "validity.from",
        "invalid",
      ],
      [
        "a duration of zero",
        { ...SEASON, validity: { type: "relative", months: 0 } },
        "validity",
        "no_duration",
      ],
      [
        "an unknown usage",
        { ...SEASON, usage: { type: "twice" } },
        "usage.type",
        "unknown",
      ],
      [
        "a quota of zero",
        { ...SEASON, usage: { type: "quota", quota: 0 } },
        "usage.quota",
        "not_positive",
      ],
      [
        "a negative lock period",
        { ...SEASON, lockMinutes: -5 },
        "lockMinutes",
        "invalid",
      ],
      [
        "a photo without personal binding",
        { ...SEASON, personal: { photo: true } },
        "personal.photo",
        "requires_personal_binding",
      ],
      [
        "an unknown capacity check",
        { ...SEASON, capacityCheck: "sometimes" },
        "capacityCheck",
        "unknown",
      ],
      ["an empty bundle", { ...SEASON, bundle: [] }, "bundle", "empty"],
      [
        "a bundle part of zero persons",
        { ...SEASON, bundle: [{ label: "Kinder", count: 0 }] },
        "bundle",
        "count_not_positive",
      ],
    ];
    cases.forEach(([name, definition, field, code]) => {
      it(`names ${name}`, () => {
        expect(problemsOf(definition)).to.deep.include({ field, code });
      });
    });
  });

  describe("passesOf", () => {
    it("issues one pass per person of a bundle", () => {
      const passes = passesOf({
        ...SEASON,
        bundle: [
          { label: "Erwachsene", count: 2 },
          { label: "Kinder", count: 3 },
        ],
      });
      expect(passes).to.have.length(5);
      expect(passes.map((pass) => pass.label)).to.deep.equal([
        "Erwachsene",
        "Erwachsene",
        "Kinder",
        "Kinder",
        "Kinder",
      ]);
      expect(passes.map((pass) => pass.position)).to.deep.equal([
        1, 2, 3, 4, 5,
      ]);
    });

    it("issues one pass without a bundle", () => {
      expect(passesOf(SEASON)).to.deep.equal([{ label: null, position: 1 }]);
    });
  });

  describe("snapshotTerms", () => {
    const issuedAt = at("2027-06-10T14:30");

    it("covers the last day of a fixed window in the facility's time zone", () => {
      const terms = snapshotTerms(SEASON, { issuedAt });
      expect(terms.validFrom).to.equal(at("2027-05-15T00:00"));
      expect(terms.validUntil).to.equal(at("2027-09-16T00:00"));
    });

    it("runs a relative validity from the issuance, across a time change", () => {
      const terms = snapshotTerms(
        { ...SEASON, validity: { type: "relative", months: 12 } },
        { issuedAt },
      );
      expect(terms.validFrom).to.equal(issuedAt);
      expect(terms.validUntil).to.equal(at("2028-06-10T14:30"));
    });

    it("takes the booked period for a booking validity", () => {
      const bookingPeriod = {
        begin: at("2027-07-01T00:00"),
        end: at("2027-07-02T00:00"),
      };
      const terms = snapshotTerms(
        { validity: { type: "booking" }, usage: { type: "single" } },
        { issuedAt, bookingPeriod },
      );
      expect(terms).to.include({
        validFrom: bookingPeriod.begin,
        validUntil: bookingPeriod.end,
        usage: "single",
        quota: null,
        lockMinutes: 0,
        capacityCheck: "booking",
      });
    });

    it("keeps the terms of the purchase when the tariff changes later (Pos. 2.2)", () => {
      const tariff = JSON.parse(
        JSON.stringify({ ...SEASON, usage: { type: "quota", quota: 10 } }),
      );
      const terms = snapshotTerms(tariff, { issuedAt });
      tariff.usage.quota = 5;
      tariff.lockMinutes = 0;
      expect(terms.quota).to.equal(10);
      expect(terms.lockMinutes).to.equal(180);
      expect(Object.isFrozen(terms)).to.equal(true);
    });

    it("refuses to issue from an invalid definition", () => {
      expect(() =>
        snapshotTerms({ ...SEASON, usage: { type: "quota" } }, { issuedAt }),
      ).to.throw(/usage.quota not_positive/);
    });
  });

  describe("describe", () => {
    it("previews a family season card in whole sentences (Pos. 3.6)", () => {
      expect(
        describeTerms({
          ...SEASON,
          personal: { required: true, photo: true },
          bundle: [
            { label: "Erwachsene", count: 2 },
            { label: "Kinder", count: 3 },
          ],
          capacityCheck: "entry",
        }),
      ).to.deep.equal([
        "Erzeugt je Buchung 5 Zugangsberechtigungen unter einem Ticket (2 × Erwachsene, 3 × Kinder).",
        "Gültig vom 15.05.2027 bis 15.09.2027.",
        "Erlaubt beliebig viele Eintritte in der Gültigkeit.",
        "Nach einem Eintritt ist 3 Stunden lang kein erneuter Eintritt möglich.",
        "Personengebunden: Name und Lichtbild werden am Einlass angezeigt.",
        "Die Kapazität der Einrichtung wird am Einlass geprüft.",
      ]);
    });

    it("previews a quota card and a relative validity", () => {
      const sentences = describeTerms({
        validity: { type: "relative", months: 12 },
        usage: { type: "quota", quota: 10 },
        lockMinutes: 90,
      });
      expect(sentences).to.include("Gültig ab dem Kauf für 12 Monate.");
      expect(sentences).to.include(
        "Erlaubt Eintritte an 10 Tagen; ein Wiedereintritt am selben Tag zählt nicht erneut.",
      );
      expect(sentences).to.include(
        "Nach einem Eintritt ist 90 Minuten lang kein erneuter Eintritt möglich.",
      );
    });

    it("shows what to fix before anything else", () => {
      expect(
        describeTerms({ ...SEASON, usage: { type: "quota", quota: 0 } }),
      ).to.deep.equal([
        "Bitte prüfen: usage.quota (muss größer als null sein).",
      ]);
    });
  });
});
