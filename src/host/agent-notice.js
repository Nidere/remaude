/**
 * The word that a background agent has finished.
 *
 * It never becomes a message in the session. The harness queues the notification
 * for the model, and the transcript keeps that queueing rather than a turn: a
 * `queue-operation` entry with the text in `content`, and an `attachment` entry
 * with the same text in `attachment.prompt`. Neither is a user or an assistant
 * message, so the ordinary bookkeeping walks straight past them — and the row in
 * the sidebar stayed "running" until the host was restarted.
 *
 * The text names both the agent and the call that started it, which is all the
 * rows in `agent-rows.js` need to know whose life just ended.
 */
export function agentNoticeText(entry) {
  const text = entry?.type === 'queue-operation' ? entry.content : entry?.attachment?.prompt;
  return typeof text === 'string' && text.includes('<task-notification>') ? text : null;
}
