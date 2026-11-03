/**
 * Writing to the usage log of a pass (glossary "Nutzungsprotokoll"), shared
 * by the check at the entrance and the issuance from the booking: the
 * projection caught up with the log before anything is decided, and an event
 * appended at the next position of the log, read again and asked anew where
 * another writer took that position first.
 */

const { applyEvent, replay, USAGE_EVENTS } = require("./admission-state");

/** How often a writer that lost the next position looks at the pass again. */
const MAX_ATTEMPTS = 3;

/**
 * The pass with a projection that has caught up with its usage log: events
 * a process appended but could not project any more are applied now, and
 * the projection is stored on the condition that nobody moved it meanwhile.
 *
 * @param {Object} store The admission store
 * @param {string} tenantId
 * @param {Object} pass The pass as read
 * @returns {Promise<Object>} The pass with its projection and version current
 */
async function catchUp(store, tenantId, pass) {
  const later = await store.eventsAfter(tenantId, pass.id, pass.version);
  if (later.length === 0) {
    return pass;
  }
  const projection = later.some(
    (event) => event.type === USAGE_EVENTS.UNDO_ENTRY,
  )
    ? replay(await store.eventsAfter(tenantId, pass.id, 0), pass.terms)
    : later.reduce(
        (current, event) => applyEvent(current, event, pass.terms),
        pass.projection,
      );
  const version = later[later.length - 1].seq;
  await store.saveProjection(pass, projection, version);
  return { ...pass, projection, version };
}

/**
 * Appends the event `eventOf` answers for the pass as it stands now. A device
 * that scanned the pass in between takes the position first; then the pass
 * is read again and `eventOf` asked again, since the event may no longer be
 * due.
 *
 * @param {Object} store The admission store
 * @param {string} tenantId
 * @param {string} passId
 * @param {function(Object): Object|null} eventOf The event for the current
 *   pass, or null where none is due
 * @returns {Promise<Object|null>} The event appended, or null where none was due
 * @throws {Error} Where the pass is gone or every attempt lost the position
 */
async function appendTo(store, tenantId, passId, eventOf) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const stored = await store.passById(tenantId, passId);
    if (!stored) {
      throw new Error(`admission log: pass ${passId} not found`);
    }
    const pass = await catchUp(store, tenantId, stored);
    const event = eventOf(pass);
    if (!event) {
      return null;
    }
    const projection = applyEvent(pass.projection, event, pass.terms);
    if (await store.appendEvent(pass, event, projection)) {
      return event;
    }
  }
  throw new Error(
    `admission log: pass ${passId} contended, no event appended after ${MAX_ATTEMPTS} attempts`,
  );
}

module.exports = { catchUp, appendTo, MAX_ATTEMPTS };
