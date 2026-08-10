/**
 * Which thread the running turn belongs to.
 *
 * The first version guessed by counting: a message written while the model was
 * busy queued its tag, and every finished turn shifted the queue along. One
 * turn that ended without the usual final message — an interrupt, a turn the
 * session merged into another — and the count was off by one from then on: an
 * answer landed in the feed while some later, unrelated answer went into the
 * thread.
 *
 * So nothing is counted now. A message written into a thread carries the thread
 * in its first line, and the session replays that message back to us at the
 * moment it starts working on it. That replay is the signal: whatever the turn
 * says from then until it reports back belongs to that thread. An ordinary
 * message clears the tag the same way.
 */
export class TurnTags {
  #active = new Map(); // chatId -> threadId | null

  /** The thread the running turn belongs to, if any. */
  active(chatId) {
    return this.#active.get(chatId) ?? null;
  }

  /** The session has taken a message into work: `threadId` or null for an ordinary one. */
  begin(chatId, threadId = null) {
    this.#active.set(chatId, threadId ?? null);
  }

  /** The turn reported back. */
  end(chatId) {
    this.#active.set(chatId, null);
  }

  forget(chatId) {
    this.#active.delete(chatId);
  }
}
