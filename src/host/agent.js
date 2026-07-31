import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chat } from './chat.js';
import { extractLimits } from './usage.js';

/**
 * Хост-агент: проекты (директории) → чаты (живые SDK-сессии).
 *
 * События (для будущего транспорта к relay/браузеру):
 *  - 'chat_message' ({chatId, projectPath, msg})
 *  - 'chat_status'  ({chatId, projectPath, status})
 *  - 'chat_error'   ({chatId, projectPath, error})
 */
export class HostAgent extends EventEmitter {
  /** @type {Map<string, {path: string, chats: Map<string, Chat>}>} */
  projects = new Map();

  /** @param onPermissionRequest общий обработчик permission-запросов всех чатов */
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

  /** Снимок лимитов для виджета — с любой живой сессии. */
  async limits() {
    for (const chat of this.allChats()) {
      if (chat.status === 'closed') continue;
      try {
        return extractLimits(await chat.rawUsage());
      } catch {
        continue; // сессия могла умереть между проверкой и вызовом — пробуем следующую
      }
    }
    return null;
  }

  closeAll() {
    for (const chat of this.allChats()) chat.close();
  }
}
