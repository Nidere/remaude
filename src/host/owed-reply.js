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
 *
 * A refused model answers — and then, as often as not, ends its turn right
 * there: a reply with no tool call after a refusal reads to it like the end of
 * the exchange (2026-10-28, twice in one chat; once it even wrote "continuing
 * with step one" and stopped). The user is left to type "yes" to get the work
 * back. So a turn that ends on such a forced reply is followed by a nudge from
 * the host, which the feed never shows.
 *
 * The nudge must not read as a yes. The first one said "do not wait for the
 * user", and a model that had just proposed a design and asked for approval
 * took it as approval. Nor should the block itself be news to the user: models
 * kept explaining it at length ("the hook blocked my tools again, so I stop").
 * It is routine, and both texts say so.
 */

// After this many refusals the calls go through anyway: whatever the model is
// doing by then, refusing it forever would turn a missed reply into a hung chat.
const MAX_REFUSALS = 3;

export const OWED_REPLY_REASON =
  'The user sent you a message while you were working, and you have not answered it yet. ' +
  'Thinking about it does not count: they cannot see your thinking. ' +
  'This block is routine and deliberate: the host holds your tools until a message written mid-turn gets a visible answer. ' +
  'Nothing is broken, and the user already knows how it works, so do not mention the block or the hook in your reply. ' +
  'Reply to their message now in plain visible text and, in the same response, call this tool again. ' +
  "Your text appears on the user's screen the moment you write it, not at the end of the turn, " +
  'and the block lifts as soon as it appears: there is no need to end your turn to answer.';

// What the host says to a session whose turn ended on a forced reply. It starts
// with a mark the transcript reader looks for, so the feed never shows it.
const NUDGE_MARK = '[remaude:continue]';
export const CONTINUE_NUDGE =
  `${NUDGE_MARK} This is the host, not the user, and it is not an answer or an approval of anything. ` +
  'Your turn ended right after the reply you were made to write; your tools are free again. ' +
  'Carry on only with work the user had already agreed to. ' +
  'Anything you proposed or asked about in your last reply waits for their answer. ' +
  'If nothing is left to do without that answer, end your turn with one short line saying you are waiting for it. ' +
  'Do not mention this message or the block.';

/** Whether a user message's content is the host's nudge rather than something the user wrote. */
export function isContinueNudge(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((b) => b.type === 'text')?.text : null;
  return typeof text === 'string' && text.startsWith(NUDGE_MARK);
}

export class OwedReply {
  #turnOpen = false;
  #owed = false;
  #refusals = 0;
  #forcedReply = false; // the last thing said was a reply the refusals pulled out
  #stalled = false;

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
      const stalled = this.#forcedReply && msg.subtype === 'success';
      this.reset();
      this.#stalled = stalled;
    } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      if (this.#owed && saysSomething(msg)) {
        this.#owed = false;
        this.#forcedReply = this.#refusals > 0;
      }
      if (callsTool(msg)) this.#forcedReply = false; // it went back to work on its own
    }
  }

  /** Once, after a turn has ended: whether it ended on a forced reply and wants a nudge. */
  takeStalled() {
    const stalled = this.#stalled;
    this.#stalled = false;
    return stalled;
  }

  /** A turn that ended without a result — an interrupt, a session that went away. */
  reset() {
    this.#turnOpen = false;
    this.#owed = false;
    this.#refusals = 0;
    this.#forcedReply = false;
    this.#stalled = false;
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

function callsTool(msg) {
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'tool_use');
}

function saysSomething(msg) {
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'text' && b.text?.trim());
}
