// Multiplayer: who else is in this building right now, through the API's /api/live WebSocket (hosted mode,
// organization buildings). Keeps the list of players and sends our own position; RemotePlayers draws them.
// The protocol is described in the worktown3d-api README ("Live protocol").

/** Position updates go out at most this often, and only when we moved or turned. */
const SEND_MS = 100;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const FULL_RETRY_MS = 60_000;

/** Close codes after which reconnecting won't help (see the API README). */
const FINAL = new Set([4000, 4001, 4401, 4403, 4409]);

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Live {
  /**
   * @param {object} hooks
   * @param {(event: string, player?: object) => void} hooks.onEvent  welcome, join, rejoin, leave, move, floor (a move
   *   to another floor), character, offline
   * @param {() => void} hooks.onSignedOut  the session ended
   * @param {(code: number, reason: string) => void} hooks.onUnavailable  presence stopped for good (see FINAL)
   */
  constructor({ onEvent, onSignedOut, onUnavailable }) {
    this.onEvent = onEvent;
    this.onSignedOut = onSignedOut;
    this.onUnavailable = onUnavailable;
    /** Everyone else in the building, by GitHub user id. */
    this.players = new Map();
    this.you = null;
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.retryMs = RETRY_MIN_MS;
    this.retryTimer = null;
    this.lastSent = null;
    this.lastSentAt = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.socket) this.socket.close(1000);
  }

  /** Someone who is here now, by GitHub login (any case), or null. */
  playerByLogin(login) {
    const key = String(login).toLowerCase();
    for (const p of this.players.values()) if (p.login.toLowerCase() === key) return p;
    return null;
  }

  /** Everyone else who is here now. */
  online() {
    return [...this.players.values()];
  }

  /** Called every frame with where we stand: `floor` is the repo of the floor we're on, or null in the lobby. */
  sendPosition(floor, x, z, yaw) {
    const now = performance.now();
    if (!this.connected || now - this.lastSentAt < SEND_MS) return;
    const last = this.lastSent;
    if (last && last.floor === floor && Math.abs(last.x - x) < 0.02 && Math.abs(last.z - z) < 0.02 && Math.abs(angleDiff(last.yaw, yaw)) < 0.02) return;
    this.lastSent = { floor, x, z, yaw };
    this.lastSentAt = now;
    this.socket.send(JSON.stringify({ t: 'move', floor, x, z, yaw }));
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
    this.socket = ws;
    ws.addEventListener('message', (e) => {
      let message;
      try {
        message = JSON.parse(e.data);
      } catch {
        return;
      }
      this.receive(message);
    });
    ws.addEventListener('close', (e) => this.closed(e));
  }

  receive(m) {
    switch (m.t) {
      case 'welcome':
        this.you = m.you;
        this.players = new Map(m.players.map((p) => [p.id, p]));
        this.connected = true;
        this.retryMs = RETRY_MIN_MS;
        this.lastSent = null; // say where we are right away, even if we're standing still
        this.onEvent('welcome');
        break;
      case 'join': {
        const known = this.players.has(m.player.id);
        this.players.set(m.player.id, m.player);
        this.onEvent(known ? 'rejoin' : 'join', m.player);
        break;
      }
      case 'leave': {
        const player = this.players.get(m.id);
        if (!player) break;
        this.players.delete(m.id);
        this.onEvent('leave', player);
        break;
      }
      case 'moves':
        for (const [id, floor, x, z, yaw] of m.m) {
          const player = id === this.you ? null : this.players.get(id);
          if (!player) continue;
          const newFloor = !player.at || player.at.floor !== floor;
          player.at = { floor, x, z, yaw };
          this.onEvent(newFloor ? 'floor' : 'move', player);
        }
        break;
      case 'character': {
        const player = this.players.get(m.id);
        if (!player) break;
        player.character = m.character;
        this.onEvent('character', player);
        break;
      }
    }
  }

  closed(e) {
    this.socket = null;
    this.connected = false;
    if (this.players.size) {
      this.players.clear();
      this.onEvent('offline');
    }
    if (this.stopped) return;
    if (e.code === 4401) {
      this.stopped = true;
      this.onSignedOut();
      return;
    }
    if (FINAL.has(e.code)) {
      this.stopped = true;
      this.onUnavailable(e.code, e.reason);
      return;
    }
    // A full building (4429), restarts (1001), dropped connections (1006) and errors: try again later.
    if (e.code === 4429) this.onUnavailable(e.code, e.reason);
    const wait = e.code === 4429 ? FULL_RETRY_MS : this.retryMs * (0.75 + Math.random() * 0.5);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, wait);
  }
}
