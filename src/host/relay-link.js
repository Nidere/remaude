// Исходящее соединение хоста с relay: туннель для удалённых браузеров.
// Протокол: relay→host {t:'open'|'msg'|'close', id, data?}; host→relay
// {t:'msg', id, data} (одному клиенту) и {t:'cast', data} (всем своим).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class RelayLink extends EventEmitter {
  #ws = null;
  #stopped = false;
  connected = false;

  constructor(baseUrl, token) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.#connect();
  }

  #connect() {
    if (this.#stopped) return;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/host?token=' + encodeURIComponent(this.token);
    const ws = new WebSocket(wsUrl);
    this.#ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.emit('status', true);
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === 'open') this.emit('client_open', msg.id);
      else if (msg.t === 'msg') this.emit('client_msg', msg.id, msg.data);
      else if (msg.t === 'close') this.emit('client_close', msg.id);
    });
    const onDown = () => {
      if (this.connected) {
        this.connected = false;
        this.emit('status', false);
        this.emit('down'); // все туннельные клиенты недействительны
      }
      if (!this.#stopped) setTimeout(() => this.#connect(), 5000);
    };
    ws.on('close', onDown);
    ws.on('error', () => ws.close());
  }

  sendTo(id, data) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'msg', id, data }));
  }

  cast(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'cast', data }));
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
  }
}
