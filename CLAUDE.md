# Working on remaude

Start with [README.md](README.md) for what the thing is and how the three parts
fit together, and [DEPLOY.md](DEPLOY.md) for standing one up from scratch.

## A change is not visible until it is shipped to the right place

The three parts ship differently, and each has its own way of reaching a browser:

- **`src/web/*`, `src/relay/*`** — run `scripts/deploy-relay.ps1`. The owner opens
  the UI through the relay, and the relay serves *its own copy* of the web assets
  from the VPS (`/opt/remaude/src/web`). Local edits never reach the screen until
  that script has run. The tunnel drops for a couple of seconds and everything
  reconnects; that is normal. Do not ask anyone to check the front end before
  deploying — they will be looking at the old build and reporting that nothing
  changed.
- **`src/host/*`** — the host must restart: ⚙ → Restart server in the UI. Ask the
  owner to press it. **Never restart the host yourself**: your session is a
  process that host spawned, and killing it kills the conversation mid-sentence.

## Deploying can fail on the ssh key, and it is not your fault

`scripts/deploy-relay.ps1` dying on its first `ssh` with `Bad permissions` means
the key's ACL has been widened. See the note about the Codex sandbox in this
machine's own instructions (⚙ beside the host in the sidebar) — the fix is two
`icacls` lines.

## Probes

`experiments/test-*.mjs` are offline and free to run in a loop.
`experiments/live/` costs tokens and starts its own host on its own port — read
its README before running one. `experiments/browser/` drives Chrome and needs
`npm install --no-save puppeteer-core`.
