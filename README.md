# remaude

A web shell for Claude Code: one browser UI instead of many VS Code windows — every project and chat in one place, reachable from anywhere, including a phone.

Working software, not a proposal. To run your own instance, see [DEPLOY.md](DEPLOY.md).

## Why

Several VS Code windows, each with its own Claude Code chats:

- no single place showing every chat and its state (thinking / waiting for you / waiting for permission);
- full tool and subagent output floods the screen;
- you are tied to the machine — no way to reach your sessions from a phone.

remaude **replaces the VS Code chat UI** rather than mirroring it. VS Code stays an editor; Claude Code sessions live here. Diff viewers, a code editor and other interactive extras are deliberately out of scope.

## How it works

```
┌──────────────────────────┐
│ Browser: desktop / phone │
│ (installable PWA)        │
└────────────┬─────────────┘
             │ HTTPS / WSS
             ▼
┌──────────────────────────┐   your own domain — the single entry
│ Relay (VPS + Caddy,      │   point. Auth, routing, push;
│ automatic TLS)           │   never stores chat content.
└────────────▲─────────────┘
             │ outbound WSS (the host dials out —
             │ no port forwarding, DDNS or static IP)
┌────────────┴─────────────┐
│ Host agent (Windows/mac):│
│ autostart, Agent SDK,    │
│ sessions, files, limits  │
└──────────────────────────┘
```

- **A chat is a live Agent SDK session** (`query()`) with its own `cwd`. Input is an open async iterator, so you can message the model while it is still working.
- The host also serves the same UI on `127.0.0.1:7699`, so it is usable with no relay at all.
- Remote browsers are tunnelled through the relay and served by the **same code path** as local ones (`VirtualClient`), so the feature set is identical inside and outside the home network.
- Everything the UI renders is the SDK's structured event stream (messages, `tool_use`/`tool_result`, stream deltas); filtering happens at the protocol level, never by parsing text.

**Data model:** account (Google) → hosts → projects → chats → subagents.

## Features

**Chat and transcript**
- live streaming of both reasoning and answer, interrupt, and steering messages sent mid-run;
- tool calls collapse into expandable chips, subagents are grouped, and one checkbox hides tool output entirely;
- markdown rendering with a copy-the-source button, timestamps, author names, and a lightbox for images;
- permission banners (allow/deny) and a mode switch up to `bypassPermissions`; model and reasoning effort selectable per chat;
- images: paste from the clipboard, or the 📎 button on mobile (gallery/camera); everything is normalised to PNG and downscaled;
- each chat keeps its own composer draft.

**Projects and sessions**
- sidebar of projects → chats with status dots, unread counters and search;
- a project is a subfolder of the host's projects root, picked from a list in the UI — works from a phone too;
- past chats: saved sessions from disk (including ones started in VS Code or the CLI) can be resumed with their full history;
- rename and close chats or projects without deleting anything on disk;
- open chats survive host restarts and reboots — they are resumed automatically.

**Infrastructure and remote access**
- Google sign-in with a strict allowlist, trusted devices, and code-based host pairing;
- chat sharing with another account: the guest reads and writes, but cannot control the host;
- installable PWA with push notifications ("waiting for permission", "done") plus tab-level signals;
- Claude usage limits (5-hour / weekly / per-model windows) and context fill shown in the header;
- signing in to Claude straight from the UI when OAuth expires — the link opens on any device;
- host autostart (Task Scheduler on Windows, launchd on macOS) and a restart button in settings;
- one-command macOS installer: the relay serves `install.sh` with its own address baked in.

## Access model

Three independent locks:

1. **Account** — Google OAuth plus an allowlist.
2. **Device** — trusted permanently once it arrives from the same public IP as the owner's host (silently, i.e. at home), or once a one-time code from the site is entered in the settings of an already trusted device.
3. **Host** — bound to an account by a token issued during pairing.

Transcripts contain everything, including secrets that wander in by accident, so nothing is reachable without auth and there are no public links. The relay terminates TLS and can technically see traffic: it is your own server — a deliberate trade-off instead of end-to-end encryption.

## Verified Agent SDK behaviour

Everything below was checked with live probes kept in `experiments/` — executable documentation rather than notes.

| Capability | How | |
|---|---|---|
| Multi-turn conversation | `query({ prompt: AsyncIterable<SDKUserMessage> })`, plus `interrupt()` | ✅ |
| Resuming sessions | `resume: <session-id>`; storage is shared with VS Code and the CLI (`~/.claude/projects/<slug>/<id>.jsonl`). Context is restored and the id is kept — but **past messages are never replayed into the stream**, so transcript history is read from the JSONL directly (`src/host/transcripts.js`, best effort) | ✅ |
| Permission prompts in your own UI | the `canUseTool` callback; still invoked for dialog tools even in bypass mode | ✅ |
| Permission modes | `permissionMode`: `default` / `acceptEdits` / `plan` / `bypassPermissions` / …; subagents inherit it | ✅ |
| Streaming | `includePartialMessages: true` → `stream_event` messages, thinking deltas included | ✅ |
| Filtering subagents | `parent_tool_use_id` (`null` for the main conversation) | ✅ |
| Images in and out | base64 inside `tool_result` blocks; on input, image blocks in `SDKUserMessage.message.content` | ✅ |
| Subscription limits | `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` returns the `/usage` data: `rate_limits.five_hour/.seven_day` (`utilization`, `resets_at`), per-model windows, extra credits. Live sessions only; officially unstable, so it is isolated in `usage.js` | ⚠ |
| Context and account | `getContextUsage()` (percentage and tokens), `accountInfo()` (email, subscription) | ✅ |

**Constraint:** two frontends on the same *live* session at once are not supported (the transcript can be corrupted). A VS Code session can be resumed in remaude, but from then on it belongs here.

Docs: [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript.md) · [streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output.md) · [sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md) · [subagents](https://code.claude.com/docs/en/agent-sdk/subagents.md) · [permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md)

## Not there yet

- **LAN mode**: traffic still goes through the relay even at home. The host already serves the UI itself; what is missing is an opt-in bind to the LAN interface with a token. Fully automatic "same network → connect directly" is blocked by mixed content and Private Network Access rules in browsers.
- **Multi-host UI**: the relay stores several hosts per account, the interface picks the first one.
- **Revoking access from the UI**: removing a trusted device or unpairing a host means editing `relay-state.json` on the server.
- **Relay state backups** and session cookie rotation.
- **Single-file binaries and a tray icon** — for now it is an installer plus OS-level autostart.

## Rejected alternatives

- **A passive JSONL transcript viewer** — cannot reply: VS Code sessions expose no input API, and the JSONL format is undocumented.
- **Built-in tooling** — claude.ai/code only shows cloud sessions; `/export` is a one-off plain text dump.
- **Headless CLI with stream-json** — no long-lived bidirectional stream and no permission requests in the stream.
- **Hosting on the PC itself (domain → home IP, no relay)** — dynamic IP needs DDNS, the router needs port forwarding, CGNAT breaks it entirely, and you end up running your own TLS and an open port exposed to scanners. A ~$5/month relay removes all of it, and hosts only ever dial out.
- **A native folder picker on the host** — useless for remote access: the dialog opens on a machine you cannot reach.

## Layout

```
src/host/    host agent: SDK sessions, WS protocol, transcripts, relay link
src/relay/   relay: OAuth, tunnelling, push, pairing
src/web/     UI (vanilla JS, no build step) and the macOS installer
scripts/     deployment and autostart helpers
experiments/ live probes used to verify SDK behaviour and the UI
```
