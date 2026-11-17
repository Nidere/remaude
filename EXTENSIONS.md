# Project extensions

A project can ship its own panels for remaude: a page of its own HTML, shown in a
sandboxed frame, fed by a command the host runs in the project folder. A chat in
that project gets a 🧩 button in its header; the panel opens as a pop-up (full
screen on a phone) and works the same through the relay.

## Where it lives

```
<project>/.remaude-ext/<id>/manifest.json
<project>/.remaude-ext/<id>/index.html      and whatever it links to
```

`<id>` is the folder name: letters, digits, `_`, `.`, `-`. A project may have
several. They are visible only in chats of that project, and never to a guest of
a shared chat. Everything is read from disk on every open, so a new or edited
extension shows up without restarting the host — reopen the panel.

## manifest.json

```json
{
  "name": "CI",
  "icon": "🔧",
  "entry": "index.html",
  "command": ["python", "tools/status.py", "json"],
  "timeout": 20
}
```

| field | | |
|---|---|---|
| `name` | optional | tab label; defaults to the id |
| `icon` | optional | one emoji; defaults to 🧩 |
| `entry` | optional | the page, relative to the extension folder; defaults to `index.html` |
| `command` | optional | an array is run as is (no shell); a string goes through the shell. Working directory: the project root |
| `timeout` | optional | seconds, 1–60, default 20 |

**The command is asked about.** The first time the panel opens, remaude shows the
command and runs nothing until the owner allows it. The approval is for the
manifest as written: change a byte of it and the next open asks again. An
extension without a command needs no approval.

## The page

The entry HTML is sent to the browser as one document: local `<script src>`,
`<link rel="stylesheet">`, `<img src>` and CSS `url()` are inlined (pictures as
`data:` URLs). Paths may not leave the extension folder. Keep scripts
self-contained — no ES module imports between files; bundle if you need them.

The frame is `sandbox="allow-scripts"` with an opaque origin, under
`default-src 'none'`: no cookies or storage of remaude, no access to the app's
page or chat, no network at all (`fetch`, remote scripts and images are
blocked), no popups, no navigation. Link clicks are stopped; `#anchor` links
scroll. Everything the page knows comes through the two calls below.

## Protocol

A helper is injected ahead of the page's own code:

```js
const d = await remaude.run();   // run the manifest's command, get its result
remaude.open('logs/build.log');  // show a project file in remaude's viewer
```

`run()` resolves with:

```js
{ ok: true,  json: {...}, at, ms }            // stdout parsed as JSON
{ ok: true,  text: "...", stderr?, at, ms }   // stdout that is not JSON
{ ok: false, error: "...", text?, stderr?, at, ms }  // non-zero exit, timeout, over the limit
```

`at` is when the run finished (ms since epoch), `ms` how long it took. The page
cannot pass arguments: the command is only ever the one in the manifest.

For live data, call `run()` on your own timer (every 5–10 s is fine). Closing the
panel destroys the page, timers and all.

`open(path)` takes a path relative to the project root; one that climbs out is
refused. Text files open in the viewer, anything else downloads.

Underneath it is `postMessage`, for anyone who prefers it directly:
`parent.postMessage({ remaude: 'run', id }, '*')` is answered with
`{ remaude: 'data', id, ...result }`; `{ remaude: 'open', path }` has no answer.

## Limits

| | |
|---|---|
| stdout of one run | 1 MB — over it the command is killed and `error` says so |
| timeout | from the manifest, at most 60 s; the process tree is killed |
| frequency | one run at a time per extension; asks while it runs share its result, and an ask within 2 s after it finished gets that same result |
| page | 8 MB with everything inlined |
| stderr | the last 4 KB come back with the result |

## Trying it before it reaches anyone

```
node experiments/test-ext.mjs <project> [id]
```

Reads the manifest exactly as the host will, builds the page and writes it to
`%TEMP%\remaude-ext-<id>.html` (open it to check the layout — `run()` has nobody
to answer it there), runs the command once with the real limits and reports
whether the output parsed as JSON and how big it was.

Then in the app: open a chat in the project and press 🧩. A host started before
extensions existed has no 🧩 at all — ⚙ → Restart server once.
