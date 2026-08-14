// A throwaway host for the probes in this folder.
//
// The probes below talk to a real host over the real protocol — that is the
// point of them. What they must never talk to is *your* host: a probe that adds
// a project to it leaves that project in the sidebar of every device you own,
// and no test has the right to do that. So each run gets its own server on its
// own port with its own config file, and takes it down when it is done.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Start a host of our own.
 * @param {{projects?: string[], port?: number, env?: object}} opts
 * @returns {Promise<{url: string, port: number, http: string, config: string, connect: () => WebSocket, stop: () => void}>}
 */
export async function startHost({ projects = [], port = 7790 + Math.floor(process.pid % 100), env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'remaude-probe-cfg-'));
  const config = join(dir, 'host.json');
  writeFileSync(config, JSON.stringify({ projects, openChats: [] }));

  const child = spawn(process.execPath, [join(REPO, 'src', 'host', 'server.js')], {
    cwd: REPO,
    env: { ...process.env, REMAUDE_PORT: String(port), REMAUDE_CONFIG: config, ...env },
    stdio: 'ignore',
  });

  const http = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(http + '/');
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`the throwaway host never came up on ${port}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const sockets = [];
  return {
    url,
    port,
    http,
    config,
    child,
    connect() {
      const ws = new WebSocket(url);
      sockets.push(ws);
      return ws;
    },
    stop() {
      for (const ws of sockets) try { ws.close(); } catch {}
      child.kill();
      killPort(port); // a host that restarted itself is a different process by now
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Whoever holds the port now, dead. Best effort: this is cleanup, not a check. */
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' });
      for (const pid of new Set(out.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop())))
        if (pid && pid !== '0') execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: 'ignore' });
    }
  } catch {
    /* nobody there — which is what we wanted */
  }
}

/** A project folder that exists only for this run. */
export const scratchProject = (tag) => mkdtempSync(join(tmpdir(), `remaude-${tag}-`));
