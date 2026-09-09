import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

// The remaude level of the system prompt: what is true of every chat in every
// project on every host, because it describes the product itself. It lives in
// code and changes with the code — the host and project levels, which describe
// one machine and one folder, are edited from the web UI and arrive as
// `extraPrompt`.
const REMAUDE_CONVENTION = `
## remaude inbox

This session runs inside remaude, whose UI has an inbox — the place the user
looks for documents written to them.

About every file you write, ask one question: who reads this next? If the answer
is the user, make \`<!-- remaude -->\` the very first line of the file, above the
title. Runbooks, handovers, plans, reports of work done, step-by-step
instructions, an answer too long to fit the chat — all of these are read by the
user next, and all of them belong in the inbox.

Living in the repository does not change that answer. A document can be part of
the project and addressed to the user at the same time: the marker is invisible
in rendered markdown and harmless in a repo, so a file being useful to the
codebase is no reason to leave it unmarked.

Leave unmarked what the repository owns for its own sake — READMEs, format and
API specs, configuration, notes to future readers of the code. Nobody is waiting
for those.

Files written anywhere under a \`.remaude/\` directory are collected
automatically and need no marker. That directory is the person's own space and
never enters the repository — it ignores itself — so put a document there when
it is for them, and in the project when the project owns it.

When you hand the writing of such a document to a subagent, say so in its task:
this convention does not reach subagents on its own, and their documents go
missing.

If you cannot decide, mark it. An extra line in a file costs nothing; a document
the user never finds costs all the work that went into it.

## Asking

remaude has no interactive questionnaires. The AskUserQuestion tool is refused
here, so reaching for it only costs a turn and lands the person back where they
started. Ask in the reply itself, in plain text, as a numbered list, with your
own recommendation where you have one — and carry on once the answers come.

## Committing

Work that is not in git is not finished. When a meaningful piece of work is
done, commit it and push — as part of doing it, without being asked and without
leaving it for later.

Everything the work produced goes in, the discussion around it included: inline
comment threads (\`*.comments.json\` beside a document) are as much a part of the
work as the document is. The exception is \`.remaude/\` — that is the person's
inbox, not the project's history, and git is already told to ignore it. Leave
anything else out of a commit only when the user asked for that specifically.

If a push is refused, stop and say so — a machine's git credentials are its
owner's business, not something to reach around. The exception is a fix the
owner has already written down: if the notes about this machine below say how
its credentials are meant to be set up, following them is repair, not a way
around the refusal.
`.trim();

/**
 * One chat = one Agent SDK session in streaming-input mode.
 *
 * The session is not the chat. A session is a `claude` process holding a third
 * of a gigabyte, and a chat that nobody has spoken to for an hour has no use
 * for one — so it sleeps, and wakes on the next word. All it takes to come back
 * is the session id, which we keep anyway.
 *
 * Events:
 *  - 'message' (msg)  — every SDK message as-is (system/assistant/user/stream_event/result/...)
 *  - 'status'  (status) — idle | thinking | waiting_permission | sleeping | closed
 *  - 'error'   (err)
 */
export class Chat extends EventEmitter {
  #queue = [];
  #wake = null;
  #closed = false;
  #query = null;
  #session = null; // identity of the current session, so a stale pump stays quiet
  #model;
  #onPermissionRequest;
  #extraPrompt; // () => string — the host and project levels, read afresh on every start
  #env; // () => object — which Claude account this session runs as, likewise

  /** Local id; after system:init it is complemented by sessionId (which is what we resume with). */
  id = randomUUID();
  sessionId = null;
  status = 'idle';
  lastActiveAt = Date.now(); // when anything last happened here — the sleep clock
  model = null; // the actual model reported by system:init
  permissionMode = 'default';

  constructor({
    cwd,
    resume,
    permissionMode = 'default',
    model,
    onPermissionRequest,
    extraPrompt,
    env,
    asleep = false,
  }) {
    super();
    this.cwd = cwd;
    this.permissionMode = permissionMode;
    this.resumeId = resume ?? null;
    this.#model = model;
    this.#onPermissionRequest = onPermissionRequest;
    this.#extraPrompt = extraPrompt ?? null;
    this.#env = env ?? null;
    if (asleep) this.status = 'sleeping';
    else this.#spawn();
  }

  /** The three levels of the appended prompt: remaude, then this host, then this project. */
  #append() {
    let extra = '';
    try {
      extra = this.#extraPrompt?.() ?? '';
    } catch {
      extra = ''; // a broken host config must not cost the user their chat
    }
    return [REMAUDE_CONVENTION, extra.trim()].filter(Boolean).join('\n\n');
  }

  /** Start the session, or do nothing if one is already running. */
  #spawn() {
    if (this.#query || this.#closed) return;
    // where to pick the conversation up: wherever it got to last
    const from = this.sessionId ?? this.resumeId ?? undefined;
    if (from) this.resumeId = from;
    const session = {};
    this.#session = session;
    const q = query({
      prompt: this.#input(session),
      options: {
        cwd: this.cwd,
        resume: from,
        // the account this project is worked on under, asked for at every start
        // so a chat that changes hands only has to sleep and wake
        ...(this.#env ? { env: this.#env() } : {}),
        permissionMode: this.permissionMode,
        model: this.#model,
        includePartialMessages: true,
        // remaude collects documents written *for the user* into an inbox. The
        // convention has to reach every session in every project, so it rides
        // along with the preset prompt instead of relying on project files.
        // The host and project levels follow it, read at start rather than at
        // construction, so an edited prompt reaches a chat as soon as it wakes.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.#append() },
        canUseTool: async (toolName, input, { signal, suggestions }) => {
          // remaude has no interactive questionnaires (and the user hates them) — so we
          // force the model to ask again in plain text. This hook fires even in bypass mode.
          if (toolName === 'AskUserQuestion') {
            return {
              behavior: 'deny',
              message:
                'Interactive questionnaires are not supported here. Ask all of your questions as plain text in your reply, as a numbered list, and continue once the user answers.',
            };
          }
          if (!this.#onPermissionRequest) return { behavior: 'allow', updatedInput: input };
          this.#setStatus('waiting_permission');
          try {
            return await this.#onPermissionRequest({ chat: this, toolName, input, suggestions, signal });
          } finally {
            if (this.status === 'waiting_permission') this.#setStatus('thinking');
          }
        },
      },
    });
    this.#query = q;
    if (this.status === 'sleeping') this.#setStatus('idle');
    this.#pump(q);
    // a session started over does not remember what it was told to run as
    if (this.effort) this.#query.applyFlagSettings({ effortLevel: this.effort }).catch(() => {});
  }

  /** Bring the session back — for a message, or because the chat was opened. */
  wake() {
    if (this.#closed) throw new Error('chat is closed');
    this.#spawn();
  }

  /**
   * Let the session go and keep the chat. Only ever an idle one: a turn in
   * flight, a permission waiting to be answered or a background agent still
   * working all mean the process is earning its memory.
   * @returns whether it actually went to sleep.
   */
  sleep() {
    if (this.#closed || !this.#query || this.status !== 'idle') return false;
    const q = this.#query;
    this.#query = null;
    this.#session = null;
    this.#wake?.(); // the input ends, stdin closes, the process leaves
    this.#setStatus('sleeping');
    Promise.resolve(q.return?.()).catch(() => {});
    return true;
  }

  async #pump(q) {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          if (msg.model) this.model = msg.model;
          if (msg.permissionMode) this.permissionMode = msg.permissionMode;
        }
        if (msg.type === 'result') this.#setStatus('idle');
        this.emit('message', msg);
      }
    } catch (err) {
      if (!this.#closed && this.#query === q) this.emit('error', err);
    } finally {
      // The session ended without being asked to — killed from outside, or it
      // fell over. That is the end of a process, not of a chat: the transcript
      // is on disk and the next message resumes from it. Only close() means a
      // chat is over. (If #query is no longer ours, it was put to sleep.)
      if (this.#query === q) {
        this.#query = null;
        this.#session = null;
        this.#setStatus('sleeping');
      }
    }
  }

  async *#input(session) {
    while (!this.#closed && this.#session === session) {
      while (this.#queue.length) yield this.#queue.shift();
      if (this.#closed || this.#session !== session) break;
      await new Promise((r) => (this.#wake = r));
    }
  }

  /** @param content string | array of Messages API content blocks (text/image) */
  send(content) {
    if (this.#closed) throw new Error('chat is closed');
    this.#spawn(); // a sleeping chat wakes to take the message
    this.#queue.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    });
    this.#setStatus('thinking');
    this.#wake?.();
  }

  /** Whether a session is running right now (as opposed to asleep or gone). */
  get awake() {
    return Boolean(this.#query);
  }

  async interrupt() {
    if (!this.#query) return; // asleep: there is nothing in flight to stop
    await this.#query.interrupt();
    // an aborted turn does not always send a result — without this the chat
    // (and its stop button) would stay "thinking" until something else moves
    this.#setStatus('idle');
  }

  // The settings below are remembered whether or not a session is running: a
  // sleeping chat is not worth waking to be told which model it will use, and
  // #spawn starts the next one the way it was last set.

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    if (this.#query) await this.#query.setPermissionMode(mode);
  }

  async contextUsage() {
    return this.#query ? this.#query.getContextUsage() : null;
  }

  async setModel(model) {
    this.#model = model ?? undefined;
    this.model = model ?? null; // the actual name will be clarified by the next init/usage
    if (this.#query) await this.#query.setModel(model);
  }

  async setEffort(level) {
    this.effort = level;
    if (this.#query) await this.#query.applyFlagSettings({ effortLevel: level });
  }

  async accountInfo() {
    if (!this.#query) throw new Error('the session is asleep');
    return this.#query.accountInfo();
  }

  /** Raw response of the experimental usage API; parsing lives in usage.js */
  async rawUsage() {
    if (!this.#query) throw new Error('the session is asleep');
    return this.#query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const q = this.#query;
    this.#query = null;
    this.#session = null;
    this.#wake?.();
    Promise.resolve(q?.return?.()).catch(() => {});
    this.#setStatus('closed');
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
