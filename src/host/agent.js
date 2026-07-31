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

  /** @param onPermissionRequest shared handler for the permission requests of all chats */
  constructor({ onPermissionRequest } = {}) {
    super();
    this.onPermissionRequest = onPermissionRequest;
  }

  addProject(path) {
    const abs = resolve(path);
    if (!statSync(abs).isDirectory()) throw new Error(`not a directory: ${abs}`);
    if (!this.projects.has(abs)) this.projects.set(abs, { path: abs, chats: new Map() });
    return this.projects.get(abs);
  }

  /** @param opts {resume?, permissionMode?, model?} */
  createChat(projectPath, opts = {}) {
    const project = this.addProject(projectPath);
    const chat = new Chat({
      cwd: project.path,
      onPermissionRequest: this.onPermissionRequest,
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
      if (chat.status === 'closed') continue;
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
