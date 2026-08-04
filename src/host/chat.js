import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

const INBOX_CONVENTION = `
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
automatically and need no marker.

When you hand the writing of such a document to a subagent, say so in its task:
this convention does not reach subagents on its own, and their documents go
missing.

If you cannot decide, mark it. An extra line in a file costs nothing; a document
the user never finds costs all the work that went into it.

## Committing

Work that is not in git is not finished. When a meaningful piece of work is
done, commit it and push — as part of doing it, without being asked and without
leaving it for later.

Everything the work produced goes in, the discussion around it included: inline
comment threads (\`*.comments.json\` beside a document) are as much a part of the
work as the document is. Leave something out of a commit only when the user
asked for that specifically.

If a push comes back with \`Permission to … denied to <some account>\`, this
machine has more than one GitHub account. Point the repository at the one that
owns it and push — do not ask, and do not switch the account globally:

\`\`\`
git config --local credential.helper ""
git config --local --add credential.helper '!f() { test "$1" = get || exit 0; echo username=ACCOUNT; echo "password=$(gh auth token --user ACCOUNT)"; }; f'
\`\`\`
`.trim();

/**
 * One chat = one live Agent SDK session in streaming-input mode.
 *
 * Events:
 *  - 'message' (msg)  — every SDK message as-is (system/assistant/user/stream_event/result/...)
 *  - 'status'  (status) — idle | thinking | waiting_permission | closed
 *  - 'error'   (err)
 */
export class Chat extends EventEmitter {
  #queue = [];
  #wake = null;
  #closed = false;
  #query;

  /** Local id; after system:init it is complemented by sessionId (which is what we resume with). */
  id = randomUUID();
  sessionId = null;
  status = 'idle';
  model = null; // the actual model reported by system:init
  permissionMode = 'default';

  constructor({ cwd, resume, permissionMode = 'default', model, onPermissionRequest }) {
    super();
    this.cwd = cwd;
    this.permissionMode = permissionMode;
    this.#query = query({
      prompt: this.#input(),
      options: {
        cwd,
        resume,
        permissionMode,
        model,
        includePartialMessages: true,
        // remaude collects documents written *for the user* into an inbox. The
        // convention has to reach every session in every project, so it rides
        // along with the preset prompt instead of relying on project files.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: INBOX_CONVENTION },
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
          if (!onPermissionRequest) return { behavior: 'allow', updatedInput: input };
          this.#setStatus('waiting_permission');
          try {
            return await onPermissionRequest({ chat: this, toolName, input, suggestions, signal });
          } finally {
            if (this.status === 'waiting_permission') this.#setStatus('thinking');
          }
        },
      },
    });
    this.#pump();
  }

  async #pump() {
    try {
      for await (const msg of this.#query) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          if (msg.model) this.model = msg.model;
          if (msg.permissionMode) this.permissionMode = msg.permissionMode;
        }
        if (msg.type === 'result') this.#setStatus('idle');
        this.emit('message', msg);
      }
    } catch (err) {
      if (!this.#closed) this.emit('error', err);
    } finally {
      this.#closed = true;
      this.#setStatus('closed');
    }
  }

  async *#input() {
    while (!this.#closed) {
      while (this.#queue.length) yield this.#queue.shift();
      if (this.#closed) break;
      await new Promise((r) => (this.#wake = r));
    }
  }

  /** @param content string | array of Messages API content blocks (text/image) */
  send(content) {
    if (this.#closed) throw new Error('chat is closed');
    this.#queue.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    });
    this.#setStatus('thinking');
    this.#wake?.();
  }

  async interrupt() {
    await this.#query.interrupt();
    // an aborted turn does not always send a result — without this the chat
    // (and its stop button) would stay "thinking" until something else moves
    this.#setStatus('idle');
  }

  async setPermissionMode(mode) {
    await this.#query.setPermissionMode(mode);
    this.permissionMode = mode;
  }

  async contextUsage() {
    return this.#query.getContextUsage();
  }

  async setModel(model) {
    await this.#query.setModel(model);
    this.model = model ?? null; // the actual name will be clarified by the next init/usage
  }

  async setEffort(level) {
    await this.#query.applyFlagSettings({ effortLevel: level });
    this.effort = level;
  }

  async accountInfo() {
    return this.#query.accountInfo();
  }

  /** Raw response of the experimental usage API; parsing lives in usage.js */
  async rawUsage() {
    return this.#query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake?.();
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
