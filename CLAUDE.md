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
- **If the host is down**, run `scripts/start-host.ps1` and nothing else. It hands
  the launch to the "remaude host" Task Scheduler task; that task also checks on the
  host every minute and brings a dead one back on its own. Never start the host
  with `node` or `Start-Process` from a session: a host that is your child dies
  when your tool call ends, silently, and takes every open chat with it.

## Deploying can fail on the ssh key, and it is not your fault

`scripts/deploy-relay.ps1` dying on its first `ssh` with `Bad permissions` means
the key's ACL has been widened. See the note about the Codex sandbox in this
machine's own instructions (⚙ beside the host in the sidebar) — the fix is two
`icacls` lines.

## An em dash inside a PowerShell string breaks the script

The `.ps1` files here are UTF-8 without a BOM, and Windows PowerShell 5.1 reads
BOM-less files as Windows-1252. An em dash decodes into `â€”`, whose last
character is a typographic right quote — which PowerShell accepts as a string
delimiter. The string ends early, the braces stop matching, and the script dies
with `Missing closing '}'` pointing at a line where nothing is wrong.

In comments none of this matters. So keep prose in `.ps1` comments as it is, and
keep everything inside quotes plain ASCII. Before trusting a script you edited:

```powershell
$e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts\x.ps1).Path, [ref]$null, [ref]$e)
$e | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }
```

`ParseFile` decodes the file the same way the interpreter will, so it sees the
problem. Reading the file yourself as UTF-8 and parsing the string does not.

## The host cannot spawn PowerShell, and fails at it quietly

`spawn('powershell', …, { detached: true })` from the host returns a pid, emits no
error, writes nothing to stderr — and never runs a line of the script.
`DETACHED_PROCESS` leaves `powershell.exe` without a console and it exits at once.
Dropping `detached` makes it run, but node puts non-detached children in a job that
dies with the parent, which is useless for anything that restarts or kills the host.

Go through `wscript` instead, the way `start-host.vbs` and `server-mode.vbs` do: a
GUI program does not mind being detached, and the shell it starts gets its own
console. Whatever it runs has to log for itself — wscript keeps no stdout.

## Probes

`experiments/test-*.mjs` are offline and free to run in a loop.
`experiments/live/` costs tokens and starts its own host on its own port — read
its README before running one. `experiments/browser/` drives Chrome and needs
`npm install --no-save puppeteer-core`.
