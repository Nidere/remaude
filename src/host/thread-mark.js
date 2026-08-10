// The line a thread message carries in front of it.
//
// It does two jobs at once: it tells the session that the answer belongs to a
// side thread, and it says which message the thread hangs off — because without
// that, "yes, let's do it" written into a thread reads as an answer to whatever
// was said last in the main conversation, and gets answered as such.
//
// The line is also what identifies the turn later: the session replays it back
// as it starts working, and that replay is how the answer is routed. So the
// quote inside it must never break the line — brackets and line breaks come out.

const MARK = /^\[remaude: thread ([0-9a-f-]{8,})/i;

export function threadMark(id, quote = null) {
  const said = clean(quote);
  return (
    `[remaude: thread ${id} — a side thread of this chat` +
    (said ? `, hanging off your message that began: “${said}…”` : '') +
    '. Answer in one message; it is filed into the thread, not the main feed.]'
  );
}

/** The thread a message belongs to, or null — read from its first line. */
export function threadIdInText(text) {
  return MARK.exec(String(text ?? '').trimStart())?.[1] ?? null;
}

/** A quote that can live inside the line: one line, no brackets, short. */
function clean(quote) {
  const said = String(quote ?? '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return said ? said.slice(0, 200) : '';
}
