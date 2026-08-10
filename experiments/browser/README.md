# Browser checks

The app driven for real: Chrome against a fake host that speaks the WS protocol,
or against an isolated copy of the host itself. They are here because every one
of them was written for a bug that had already reached the screen — a button
that did nothing, a table that rendered into the dom and not onto the page, an
answer that landed in the wrong place.

They need Chrome and puppeteer, which is not a dependency of the project:

```
npm install --no-save puppeteer-core
node experiments/browser/run.mjs
```

| file | what it holds to |
|---|---|
| `run.mjs` | comments in a document: selecting, anchoring, threads, resolving |
| `run-threads.mjs` | threads in a chat (add `mobile` for the phone layout) |
| `run-drafts.mjs` | drafts that survive anything, and attaching files |
| `run-mobile.mjs` | a phone: the stop button, the wake lock, markup while typing, the scroll |
| `run-mobile-full.mjs` | a phone, everything else: explorer, viewer, comments, escape |
| `run-settings.mjs` | settings belong to one computer of several |
| `smoke-comments.mjs` | the protocol against a real host, in an isolated home |
| `smoke-threads.mjs` | what the host refuses, and writes nothing for |

Each prints `ok:` per check and a single line at the end; a failure says what it
expected and stops. They are meant to be read as descriptions of behaviour, so
keep the messages plain.
