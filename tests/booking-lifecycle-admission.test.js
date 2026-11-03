/**
 * The adapter `admission` in the transitions of the booking lifecycle
 * (docs/admission.md, "Issuance"), over the in-memory adapters: the passes
 * of a booking's tickets issued at `confirmed`, voided with the cause of a
 * cancellation, a rejection or a withdrawal, issued again on a
 * reinstatement and an amendment, and a failure recorded while the booking
 * keeps its state.
 */

process.env.CRYPTO_SECRET =
  process.env.CRYPTO_SECRET || "0123456789abcdef0123456789abcdef";

const { expect } = require("chai");

const {
  createBookingLifecycle,
} = require("../src/commons/services/booking-lifecycle/booking-lifecycle");
const {
  createGroupBookingLifecycle,
} = require("../src/commons/services/booking-lifecycle/group-booking-lifecycle");
const {
  TRIGGER,
} = require("../src/commons/services/booking-lifecycle/booking-state");
const { Booking } = require("../src/commons/entities/booking/booking");
const {
  inMemoryAdapters,
  effectTable,
} = require("./helpers/in-memory-lifecycle-adapters");

const TENANT = "tenant-1";
const GROUP = "G-1";
const NOW = 1_756_800_000_000;
const DAY = 24 * 60 * 60 * 1000;

const SEASON_TICKET = Object.freeze({
  bookableId: "saisonkarte",
  amount: 2,
  _bookableUsed: {
    id: "saisonkarte",
    type: "ticket",
    title: "Saisonkarte",
    relatedBookableIds: ["freibad"],
    admission: {
      validity: { type: "fixed", from: "2027-05-15", to: "2027-09-15" },
      usage: { type: "unlimited" },
    },
  },
});
const ROOM = Object.freeze({
  bookableId: "room",
  amount: 1,
  _bookableUsed: { type: "room" },
});

function booking(overrides = {}) {
  return {
    id: "B-1",
    tenantId: TENANT,
    status: "confirmed",
    priceEur: 40,
    timeBegin: NOW + 10 * DAY,
    timeEnd: NOW + 11 * DAY,
    paymentProvider: "giroCockpit",
    mail: "erika@example.test",
    name: "Erika Muster",
    comment: "",
    attachments: [],
    hooks: [],
    accessInfo: [],
    cancellationPolicy: { userCancellable: true, contactHint: "" },
    bookableItems: [SEASON_TICKET],
    ...overrides,
  };
}

function lifecycleOver(options) {
  const adapters = inMemoryAdapters(options);
  return { adapters, lifecycle: createBookingLifecycle(adapters) };
}

/** The admission calls as `op cause`, with the state the booking was in. */
const admissionCalls = (adapters) =>
  adapters.admission.calls.map(({ op, args: [tenantId, passed, cause] }) => ({
    op,
    tenantId,
    bookingId: passed.id,
    status: passed.status,
    ...(cause ? { cause } : {}),
  }));

const admissionRows = (outcome) =>
  effectTable(outcome).filter((row) => row.includes("admission."));

describe("booking lifecycle: the passes of admission", function () {
  it("issues the passes of a paid booking with the grant, before its receipt", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ status: "payment_due" })],
    });

    const outcome = await lifecycle.pay(TENANT, "B-1", {
      trigger: TRIGGER.PAYMENT,
    });

    expect(effectTable(outcome).slice(0, 4)).to.deep.equal([
      "persist store.save ok",
      "provision access.provision ok",
      "provision admission.issue ok",
      "document documents.issue ok",
    ]);
    expect(admissionCalls(adapters)).to.deep.equal([
      { op: "issue", tenantId: TENANT, bookingId: "B-1", status: "confirmed" },
    ]);
    expect(adapters.admission.calls[0].args[1].bookableItems).to.deep.equal([
      SEASON_TICKET,
    ]);
  });

  it("issues at the admission and the confirmation only what is confirmed", async function () {
    const free = { priceEur: 0 };
    const admitted = lifecycleOver({
      bookings: [
        booking({ ...free, id: "B-1", status: "confirmed" }),
        booking({ ...free, id: "B-2", status: "requested" }),
      ],
    });
    const confirmed = lifecycleOver({
      bookings: [booking({ ...free, status: "requested" })],
    });

    const rows = [
      ...admissionRows(
        await admitted.lifecycle.admit(TENANT, "B-1", {
          trigger: TRIGGER.CUSTOMER,
        }),
      ),
      ...admissionRows(
        await admitted.lifecycle.admit(TENANT, "B-2", {
          trigger: TRIGGER.CUSTOMER,
        }),
      ),
      ...admissionRows(
        await confirmed.lifecycle.confirm(TENANT, "B-1", {
          trigger: TRIGGER.ADMIN,
        }),
      ),
    ];

    expect(rows).to.deep.equal([
      "provision admission.issue ok",
      "provision admission.issue skipped",
      "provision admission.issue ok",
    ]);
  });

  it("voids with the cause of the cancellation, the rejection and the withdrawal", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [
        booking({ id: "B-1", status: "confirmed" }),
        booking({ id: "B-2", status: "requested" }),
        booking({ id: "B-3", status: "confirmed" }),
      ],
    });

    await lifecycle.cancel(TENANT, "B-1", { trigger: TRIGGER.ADMIN });
    await lifecycle.cancel(TENANT, "B-2", { trigger: TRIGGER.ADMIN });
    const withdrawn = await lifecycle.acceptWithdrawal(TENANT, "B-3", {
      trigger: TRIGGER.ADMIN,
    });

    expect(admissionCalls(adapters).map((call) => call.cause)).to.deep.equal([
      "booking_cancelled",
      "booking_rejected",
      "booking_withdrawn",
    ]);
    expect(admissionRows(withdrawn)).to.deep.equal([
      "provision admission.void ok",
    ]);
  });

  it("issues again on a reinstatement to confirmed and leaves a reinstated request waiting", async function () {
    const cancelledFrom = (status) => ({
      status: status === "requested" ? "rejected" : "cancelled",
      cancellationRefund: {
        cancelledAt: NOW,
        appliedRefundPercentage: 100,
        origin: "admin",
        status: status === "requested" ? "rejected" : "cancelled",
        cancelledFrom: status,
      },
    });
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [
        booking({ id: "B-1", ...cancelledFrom("confirmed") }),
        booking({ id: "B-2", ...cancelledFrom("requested") }),
      ],
    });

    const back = await lifecycle.reinstate(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
    });
    const waiting = await lifecycle.reinstate(TENANT, "B-2", {
      trigger: TRIGGER.ADMIN,
    });

    expect(back.status).to.equal("confirmed");
    expect(admissionRows(back)).to.deep.equal(["provision admission.issue ok"]);
    expect(waiting.status).to.equal("requested");
    expect(admissionRows(waiting)).to.deep.equal([
      "provision admission.issue skipped",
    ]);
    expect(admissionCalls(adapters)).to.have.length(1);
  });

  it("lets the passes follow an amendment of a confirmed booking, also one that drops every ticket", async function () {
    const { adapters, lifecycle } = lifecycleOver({ bookings: [booking()] });

    const fewer = await lifecycle.amend(
      TENANT,
      new Booking(
        booking({ bookableItems: [{ ...SEASON_TICKET, amount: 1 }] }),
      ),
      { trigger: TRIGGER.ADMIN },
    );
    const none = await lifecycle.amend(
      TENANT,
      new Booking(booking({ bookableItems: [ROOM] })),
      { trigger: TRIGGER.ADMIN },
    );

    expect([...admissionRows(fewer), ...admissionRows(none)]).to.deep.equal([
      "provision admission.issue ok",
      "provision admission.issue ok",
    ]);
    expect(
      adapters.admission.calls.map(({ args }) => args[1].bookableItems.length),
    ).to.deep.equal([1, 1]);
  });

  it("records a failed issuance: the booking is paid and confirmed all the same", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ status: "payment_due" })],
      failOn: { admission: ["issue"] },
    });

    const outcome = await lifecycle.pay(TENANT, "B-1", {
      trigger: TRIGGER.PAYMENT,
    });

    expect(admissionRows(outcome)).to.deep.equal([
      "provision admission.issue recorded",
    ]);
    expect(outcome).to.include({ status: "confirmed", failure: null });
    expect(adapters.store.rows.get("B-1")).to.include({
      status: "confirmed",
      isPayed: true,
    });
    expect(adapters.mail.calls.map((call) => call.args[0])).to.include(
      "BOOKING_CONFIRMATION",
    );
  });

  it("issues per member of a group, only where the member books a ticket of admission", async function () {
    const member = (id, items) => ({
      ...booking({ id, status: "payment_due", bookableItems: items }),
      groupBookingId: GROUP,
    });
    const adapters = inMemoryAdapters({
      bookings: [member("B-1", [SEASON_TICKET]), member("B-2", [ROOM])],
      groups: [
        {
          id: GROUP,
          tenantId: TENANT,
          bookingIds: ["B-1", "B-2"],
          mail: "erika@example.test",
          assignedUserId: "user-1",
          hooks: [],
        },
      ],
    });
    const lifecycle = createGroupBookingLifecycle(adapters);

    const paid = await lifecycle.pay(TENANT, GROUP, {
      trigger: TRIGGER.ADMIN,
    });
    const cancelled = await lifecycle.cancel(TENANT, GROUP, {
      trigger: TRIGGER.ADMIN,
    });

    expect([...admissionRows(paid), ...admissionRows(cancelled)]).to.deep.equal(
      [
        "provision admission.issue B-1 ok",
        "provision admission.issue B-2 skipped",
        "provision admission.void B-1 ok",
        "provision admission.void B-2 skipped",
      ],
    );
    expect(admissionCalls(adapters)).to.deep.equal([
      { op: "issue", tenantId: TENANT, bookingId: "B-1", status: "confirmed" },
      {
        op: "void",
        tenantId: TENANT,
        bookingId: "B-1",
        status: "cancelled",
        cause: "booking_cancelled",
      },
    ]);
  });
});
