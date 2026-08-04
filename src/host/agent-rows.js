/**
 * The rows of running subagents in the sidebar.
 *
 * Reading a subagent's life out of the message stream is guesswork, and the
 * guesses are easy to get subtly wrong — so the rules live here, alone and
 * tested. Two of them are the whole difficulty:
 *
 *  - a background agent answers its tool call twice: "launched" right away and
 *    the real report minutes later. The first answer is not the end of it;
 *  - the harness may announce that completion by agent id instead of by the
 *    original tool call, so any message naming a running agent's id counts as
 *    its report — except the launch announcement, which names it too.
 */
export class AgentRows {
  #rows = new Map(); // toolUseId -> row

  /** An Agent tool call started. */
  start(id, { label, type, now = Date.now() }) {
    this.#rows.set(id, { id, label, type, status: 'running', startedAt: now, async: false, agentId: null });
    return true;
  }

  /**
   * The answer to an Agent tool call. `token` identifies the message it came
   * in, so the launch announcement is not mistaken for the report.
   */
  /** @returns 'launched' | 'finished' | null — null when this is not an agent row. */
  onToolResult(id, { text = '', isError = false, token = null, now = Date.now() } = {}) {
    const row = this.#rows.get(id);
    if (!row) return null;
    if (text.slice(0, 200).toLowerCase().includes('async agent launched')) {
      row.async = true;
      row.agentId = /agentid:\s*([0-9a-z]+)/i.exec(text)?.[1] ?? null;
      row.launchToken = token; // this very message announced it — it cannot also end it
      return 'launched';
    }
    return this.finish(id, isError ? 'failed' : 'done', now) ? 'finished' : null;
  }

  /**
   * Anything naming a running agent's id is its completion — bar its own launch.
   * @returns the ids that just ended.
   */
  onMention(blob, { token = null, now = Date.now() } = {}) {
    const ended = [];
    for (const row of this.#rows.values()) {
      if (row.status !== 'running') continue;
      if (row.launchToken !== null && row.launchToken === token) continue;
      // the harness names a finished agent by its own id, and its notification
      // carries the id of the call that started it — either one is the report
      const named = (row.agentId && blob.includes(row.agentId)) || blob.includes(row.id);
      if (named && this.finish(row.id, 'done', now)) ended.push(row.id);
    }
    return ended;
  }

  /**
   * The turn ended: a foreground agent that never reported back is gone.
   * @returns the ids that were aborted.
   */
  abortForeground(now = Date.now()) {
    const ended = [];
    for (const row of this.#rows.values()) if (!row.async && this.finish(row.id, 'aborted', now)) ended.push(row.id);
    return ended;
  }

  finish(id, status, now = Date.now()) {
    const row = this.#rows.get(id);
    if (!row || row.status !== 'running') return false;
    row.status = status;
    row.endedAt = now;
    return true;
  }

  /** How many rows exist — the reconnect path asks before broadcasting. */
  get size() {
    return this.#rows.size;
  }

  drop(id) {
    this.#rows.delete(id);
  }

  has(id) {
    return this.#rows.has(id);
  }

  list() {
    return [...this.#rows.values()].map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
    }));
  }
}
