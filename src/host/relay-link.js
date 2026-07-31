// The host's outbound connection to the relay: a tunnel for remote browsers.
// Protocol: relay→host {t:'open'|'msg'|'close', id, data?}; host→relay
// {t:'msg', id, data} (to a single client) and {t:'cast', data} (to all of its own).
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
      if (msg.t === 'open') this.emit('client_open', msg.id, msg.guest ?? null);
      else if (msg.t === 'msg') this.emit('client_msg', msg.id, msg.data);
      else if (msg.t === 'close') this.emit('client_close', msg.id);
      else if (msg.t === 'device_approved') this.emit('device_approved', msg.code, msg.ok);
    });
    const onDown = () => {
      if (this.connected) {
        this.connected = false;
        this.emit('status', false);
        this.emit('down'); // every tunnelled client is now invalid
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

  /** Ask the relay to send a push notification to the host owner. */
  push(payload) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'push', payload }));
  }

  /** Approve a new device's code (entered on an already trusted device). */
  approveDevice(code) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'approve_device', code }));
    else throw new Error('no connection to the relay');
  }

  /** Announce the current list of shares to the relay: [{sessionId, emails}] */
  setShares(shares) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'shares', shares }));
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
  }
}
