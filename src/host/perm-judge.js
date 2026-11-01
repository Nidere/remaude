/**
 * A second opinion on the permission requests that get through bypass mode.
 *
 * In bypassPermissions the SDK approves everything by itself and only asks when
 * one of Claude Code's own safety checks fires — `rm -rf` at the root of a drive,
 * a `cd` out of the project, and the like. Most of those are the session tidying
 * up after itself, and a card waiting on the phone for that is pure friction. So
 * before the card is shown, a small separate session reads the request against
 * what the chat has been doing and either lets it through or hands it on to the
 * person with its reason. It never denies: "no" stays a human decision.
 *
 * A fresh session rather than a fork of the asking one, on purpose: a fork is the
 * whole context at the chat's own price, and it is the same mind that already
 * decided the command was a good idea.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

export const JUDGE_MODEL = 'sonnet';
const TIMEOUT_MS = 20_000;

const SYSTEM = `You review a single permission request from a Claude Code session.

The session runs in bypass mode: almost everything it does is approved without asking. This request reached you because one of Claude Code's built-in safety checks flagged it anyway, typically a recursive delete near a drive root or outside the project, a cd into another folder, a forced git operation.

Your job is to save the owner a needless prompt without letting a real mistake through. Answer "allow" when the action plainly follows from what the user asked for or what the session is visibly doing, AND its targets are things the session itself created or that are disposable: temporary directories, worktrees and clones it set up, build output, caches. The context below shows the session's recent words and tool calls; a path that a recent call created is strong evidence.

Answer "ask" when any of this holds:
- it could destroy data the session did not create, or whose origin the context does not show;
- it reaches outside the project in a way the context does not explain;
- it rewrites shared history (force push, deleting remote branches), touches credentials, keys, system directories or other users' files;
- it kills processes by name, frees or takes port 7699, or restarts the remaude host: every chat on the machine lives in that process;
- the command is too long or too obscure to read with confidence, or you are unsure for any other reason.

Reply with one JSON object and nothing else:
{"decision": "allow" | "ask", "reason": "<one short sentence, in the language the user writes in>"}`;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** One line for a tool call — the parts of its input that say what it touches. */
function callLine(block) {
  const i = block.input ?? {};
  const what = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? JSON.stringify(i);
  return `[${block.name}] ${clip(String(what), 300)}`;
}

/**
 * What the judge reads about the chat: the tail of the conversation as it went —
 * the user's messages, the model's words and its tool calls — newest last, cut to
 * a size a small model reads in a few seconds.
 */
export function buildBrief(history, { maxChars = 8000 } = {}) {
  const lines = [];
  for (const msg of history ?? []) {
    if (msg.threadRef) continue; // service turns (comment threads, naming) say nothing about the work
    const sub = msg.parent_tool_use_id ? 'subagent ' : '';
    if (msg.type === 'user') {
      const content = msg.message?.content;
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
      const text = textOf(content).trim();
      if (text) lines.push(`${sub}USER: ${clip(text, 1200)}`);
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) lines.push(`${sub}ASSISTANT: ${clip(block.text.trim(), 800)}`);
        else if (block.type === 'tool_use') lines.push(`${sub}CALL ${callLine(block)}`);
      }
    }
  }
  // newest first until the budget runs out, then back into reading order
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size + lines[i].length <= maxChars; i--) {
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return kept.join('\n');
}

/** The verdict out of the judge's reply, or null when there is no usable one. */
export function parseVerdict(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]);
    if (v.decision !== 'allow' && v.decision !== 'ask') return null;
    return { decision: v.decision, reason: String(v.reason ?? '').trim().slice(0, 300) };
  } catch {
    return null;
  }
}

export function judgePrompt({ toolName, input, cwd, history }) {
  return (
    `Working directory of the session: ${cwd}\n\n` +
    `Recent conversation, oldest first:\n<context>\n${buildBrief(history) || '(nothing yet)'}\n</context>\n\n` +
    `The request:\n<request>\ntool: ${toolName}\ninput: ${clip(JSON.stringify(input, null, 2), 4000)}\n</request>`
  );
}

/**
 * Ask the judge. Resolves to `{decision, reason}`, or null if it failed, timed out
 * or answered something unreadable — the caller falls back to asking the person.
 */
export async function judgePermission({ toolName, input, cwd, history, env, signal }) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  const onAbort = () => abortController.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const q = query({
      prompt: judgePrompt({ toolName, input, cwd, history }),
      options: {
        cwd,
        model: JUDGE_MODEL,
        systemPrompt: SYSTEM,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController,
        ...(env ? { env } : {}),
      },
    });
    let text = '';
    for await (const msg of q) {
      if (msg.type === 'assistant') text += textOf(msg.message?.content);
      if (msg.type === 'result') break;
    }
    return parseVerdict(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
