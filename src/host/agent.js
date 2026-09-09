import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chat } from './chat.js';
import { extractLimits } from './usage.js';

/**
 * Host agent: projects (directories) → chats (live SDK sessions).
 *
 * Events (for the future transport to the relay/browser):
 *  - 'chat_message' ({chatId, projectPath, msg})
 *  - 'chat_status'  ({chatId, projectPath, status})
 *  - 'chat_error'   ({chatId, projectPath, error})
 */
export class HostAgent extends EventEmitter {
  /** @type {Map<string, {path: string, chats: Map<string, Chat>}>} */
  projects = new Map();

  /**
   * @param onPermissionRequest shared handler for the permission requests of all chats
   * @param extraPrompt (projectPath) => string — the host and project levels of the
   *        system prompt, asked for anew whenever a session starts
   * @param sessionEnv (projectPath) => object — the environment of a session, and with
   *        it the Claude account the project is worked on under; asked for the same way
   */
  constructor({ onPermissionRequest, extraPrompt, sessionEnv } = {}) {
    super();
    this.onPermissionRequest = onPermissionRequest;
    this.extraPrompt = extraPrompt ?? null;
    this.sessionEnv = sessionEnv ?? null;
  }

  addProject(path) {
    const abs = resolve(path);
    if (!statSync(abs).isDirectory()) throw new Error(`not a directory: ${abs}`);
    // Windows paths are case-insensitive, Map keys are not: a transcript may
    // record the same folder as c:\... while the sidebar has C:\... — that must
    // not become a second project (it did: opening a session from search).
    const existing = this.findProject(abs);
    if (existing) return existing;
    this.projects.set(abs, { path: abs, chats: new Map() });
    return this.projects.get(abs);
  }

  findProject(path) {
    const direct = this.projects.get(path);
    if (direct || process.platform !== 'win32') return direct ?? null;
    const key = path.toLowerCase();
    for (const p of this.projects.values()) if (p.path.toLowerCase() === key) return p;
    return null;
  }

  /** @param opts {resume?, permissionMode?, model?} */
  createChat(projectPath, opts = {}) {
    const project = this.addProject(projectPath);
    const chat = new Chat({
      cwd: project.path,
      onPermissionRequest: this.onPermissionRequest,
      extraPrompt: this.extraPrompt ? () => this.extraPrompt(project.path) : undefined,
      env: this.sessionEnv ? () => this.sessionEnv(project.path) : undefined,
      ...opts,
    });
    project.chats.set(chat.id, chat);
    chat.on('message', (msg) => this.emit('chat_message', { chatId: chat.id, projectPath: project.path, msg }));
    chat.on('status', (status) => this.emit('chat_status', { chatId: chat.id, projectPath: project.path, status }));
    chat.on('error', (error) => this.emit('chat_error', { chatId: chat.id, projectPath: project.path, error }));
    return chat;
  }

  *allChats() {
    for (const p of this.projects.values()) yield* p.chats.values();
  }

  /** Snapshot of the limits for the widget — taken from any live session. */
  async limits() {
    for (const chat of this.allChats()) {
      if (!chat.awake) continue; // asking a sleeping chat would only wake it
      try {
        return extractLimits(await chat.rawUsage());
      } catch {
        continue; // the session could have died between the check and the call — try the next one
      }
    }
    return null;
  }

  closeAll() {
    for (const chat of this.allChats()) chat.close();
  }
}
