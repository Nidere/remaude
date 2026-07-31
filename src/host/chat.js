import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Один чат = одна живая сессия Agent SDK в streaming-input режиме.
 *
 * События:
 *  - 'message' (msg)  — каждое SDK-сообщение как есть (system/assistant/user/stream_event/result/...)
 *  - 'status'  (status) — idle | thinking | waiting_permission | closed
 *  - 'error'   (err)
 */
export class Chat extends EventEmitter {
  #queue = [];
  #wake = null;
  #closed = false;
  #query;

  /** Локальный id; после system:init дополняется sessionId (им же резюмим). */
  id = randomUUID();
  sessionId = null;
  status = 'idle';
  model = null; // фактическая модель из system:init
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
        canUseTool: async (toolName, input, { signal, suggestions }) => {
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

  /** @param content string | массив content-блоков Messages API (text/image) */
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
    this.model = model ?? null; // фактическое имя уточнится из следующего init/usage
  }

  async setEffort(level) {
    await this.#query.applyFlagSettings({ effortLevel: level });
    this.effort = level;
  }

  async accountInfo() {
    return this.#query.accountInfo();
  }

  /** Сырой ответ экспериментального usage-API; парсинг — в usage.js */
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
