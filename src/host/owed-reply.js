/**
 * A message written while the model is busy is owed a reply in words.
 *
 * The session folds such a message into the running turn, and the model is told
 * to address it — and often does, in its thinking, which nobody sees. Then it
 * goes straight back to its tools: on 2026-10-27 a question sat unanswered for
 * twenty minutes of work, and the model only noticed when asked again. Telling
 * it more firmly in the prompt did not help; it had been told twice already.
 *
 * So the host holds it to that. The fold shows up in the stream as a
 * `command_lifecycle` frame going to `started` while a turn is already open;
 * from then until the model says something visible, its tool calls are refused
 * with the reason. A model that answers on its own never notices this exists.
 */

// After this many refusals the calls go through anyway: whatever the model is
// doing by then, refusing it forever would turn a missed reply into a hung chat.
const MAX_REFUSALS = 3;

export const OWED_REPLY_REASON =
  'The user sent you a message while you were working, and you have not answered it yet. ' +
  'Thinking about it does not count: they cannot see your thinking. ' +
  'Reply to their message now in plain visible text, then continue with your work.';

export class OwedReply {
  #turnOpen = false;
  #owed = false;
  #refusals = 0;

  /** Feed every message the session streams. */
  observe(msg) {
    if (msg.type === 'command_lifecycle' && msg.state === 'started') {
      // a second message taken into a turn that is already running
      if (this.#turnOpen) {
        this.#owed = true;
        this.#refusals = 0;
      }
      this.#turnOpen = true;
    } else if (msg.type === 'result') {
      this.reset();
    } else if (msg.type === 'assistant' && !msg.parent_tool_use_id && saysSomething(msg)) {
      this.#owed = false;
    }
  }

  /** A turn that ended without a result — an interrupt, a session that went away. */
  reset() {
    this.#turnOpen = false;
    this.#owed = false;
    this.#refusals = 0;
  }

  /** The reason to refuse a main-thread tool call, or null to let it through. */
  refusal() {
    if (!this.#owed) return null;
    if (++this.#refusals > MAX_REFUSALS) {
      this.#owed = false;
      return null;
    }
    return OWED_REPLY_REASON;
  }

  get owed() {
    return this.#owed;
  }
}

function saysSomething(msg) {
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'text' && b.text?.trim());
}
