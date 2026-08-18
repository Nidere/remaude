# Live probes

These need a running host and, most of them, the real model. They are the ones
that answer "does this actually work end to end" — the protocol, resumption,
transcript tailing, subagent reporting, self-restart.

**They never touch your host.** Each run starts its own server on its own port
with its own config file (`host.mjs`) and takes it down afterwards. This is not
tidiness: a probe that sends `add_project` to the real host leaves a temp folder
sitting in the sidebar of every device you own, and every run adds another one.

That is also why they are not named `test-*.mjs`. Everything matching that
pattern in `experiments/` is offline and free to run in a loop; everything here
costs tokens and takes a minute or two, so it is run deliberately, one at a
time.

```
node experiments/live/ws-client.mjs
```

| file | what it answers |
|---|---|
| `ws-client.mjs` | the whole protocol: project → chat → message → permission → file on disk → history |
| `agents.mjs` | a subagent is reported running and then finished |
| `sync.mjs` | an entry appended to the transcript by someone else reaches the feed |
| `tail-fresh.mjs` | the same, for a chat started here rather than reopened — its transcript appears late |
| `echo-dupe.mjs` | one message sent, one user bubble back |
| `sessions.mjs` | a session on disk can be listed, opened and read (`<projectDir> <sessionId> [text]`) |
| `restart.mjs` | the host restarts itself and comes back |
| `guard.mjs` | foreign origin, path traversal, bare `/connect` |
| `startup.mjs` | the process boots and reopens its chats |
| `search.mjs` | transcript search, including the second page |
| `ctx.mjs` | how slow the context count is, and that the header goes out without waiting for it |
| `usage.mjs` · `image.mjs` · `askuser.mjs` · `cwd.mjs` · `resume.mjs` | SDK behaviour the README's table claims |
