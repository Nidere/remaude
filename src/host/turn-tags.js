/**
 * Which thread the next turn belongs to.
 *
 * A message written while the model is busy waits in the SDK's queue, so its
 * tag has to wait with it: tagging the running turn would file an answer to
 * something else into the thread. Every message queued behind the current turn
 * keeps its place — untagged ones included, or the tags would shift onto the
 * wrong turns.
 */
export class TurnTags {
  #active = new Map(); // chatId -> threadId | null
  #queue = new Map(); // chatId -> [threadId | null]
  // Whether a turn is running right now. The caller's view of "busy" comes from
  // a status that lags by a tick, so two messages sent back to back would both
  // look like the start of a turn — and the second would steal the first one's
  // tag. What we started ourselves, we know for certain.
  #inFlight = new Set();

  /** The thread the running turn belongs to, if any. */
  active(chatId) {
    return this.#active.get(chatId) ?? null;
  }

  queued(chatId) {
    return [...(this.#queue.get(chatId) ?? [])];
  }

  /** A message was sent. `busy` is the chat's state *before* it was handed over. */
  onSend(chatId, { busy, threadId = null }) {
    const queue = this.#queue.get(chatId) ?? [];
    if (!busy && !queue.length && !this.#inFlight.has(chatId)) {
      this.#active.set(chatId, threadId);
      this.#inFlight.add(chatId);
      return;
    }
    queue.push(threadId);
    this.#queue.set(chatId, queue);
  }

  /** A turn ended: whatever was queued behind it now owns the next one. */
  onTurnEnd(chatId) {
    const queue = this.#queue.get(chatId) ?? [];
    if (queue.length) {
      this.#active.set(chatId, queue.shift());
      this.#inFlight.add(chatId); // the queued message starts its turn immediately
    } else {
      this.#active.set(chatId, null);
      this.#inFlight.delete(chatId);
    }
    this.#queue.set(chatId, queue);
  }

  forget(chatId) {
    this.#active.delete(chatId);
    this.#queue.delete(chatId);
    this.#inFlight.delete(chatId);
  }
}
