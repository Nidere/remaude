// The line a message carries in front of it when the person who wrote it is not
// the owner of this machine.
//
// A transcript records nothing about who typed: every entry looks like the owner
// sitting at the keyboard. So while the host is running, a guest's message is
// theirs and the feed knows it — and the moment the host restarts, the whole
// conversation is read back off disk as if one person had held it. The sender
// has to be written where the text is written, and there is only one such place.
//
// It is the same device the thread tag uses: one line in front, taken off again
// when the history is loaded, so it never reaches the feed. The model does see
// it, which is the other half of the point — in a chat with two people in it,
// which one is speaking is worth knowing.

const MARK = /^\[remaude: from ([^\]\n]+)\]\n?/i;

export function senderMark(email) {
  return `[remaude: from ${clean(email)}]`;
}

/** Who wrote this, or null — read from the first line. */
export function senderInText(text) {
  return MARK.exec(String(text ?? ''))?.[1].trim() ?? null;
}

export function stripSenderMark(text) {
  return String(text ?? '').replace(MARK, '');
}

/** Put the line in front of what was typed, whatever shape it came in. */
export function withSenderMark(content, email) {
  const mark = senderMark(email);
  if (typeof content === 'string') return `${mark}\n${content}`;
  if (!Array.isArray(content)) return content;
  const i = content.findIndex((b) => b.type === 'text');
  if (i === -1) return [{ type: 'text', text: mark }, ...content];
  return content.map((b, k) => (k === i ? { ...b, text: `${mark}\n${b.text}` } : b));
}

/** The sender and the message without the line — for reading a transcript back. */
export function takeSenderMark(content) {
  if (typeof content === 'string') {
    const email = senderInText(content);
    return email ? { email, content: stripSenderMark(content) } : { email: null, content };
  }
  if (!Array.isArray(content)) return { email: null, content };
  const i = content.findIndex((b) => b.type === 'text');
  if (i === -1) return { email: null, content };
  const email = senderInText(content[i].text);
  if (!email) return { email: null, content };
  return {
    email,
    content: content.map((b, k) => (k === i ? { ...b, text: stripSenderMark(b.text) } : b)),
  };
}

/** Nothing that could end the line early or start a second one. */
function clean(email) {
  return String(email ?? '')
    .replace(/[[\]\n]/g, '')
    .trim();
}
