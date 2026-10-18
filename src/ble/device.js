// Base class for one BLE peripheral: pick, connect, auto-reconnect, status events.
// Subclasses implement setup(server) and applyState(state).

export const Status = {
  IDLE: 'idle',             // never connected this session
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  LOST: 'lost',             // was connected, retrying
  READY: 'ready',           // picked and reachable, connects on demand (the hat)
};

export class RigDevice extends EventTarget {
  constructor({ key, label, filters, optionalServices = [] }) {
    super();
    this.key = key;
    this.label = label;
    this.filters = filters;
    this.optionalServices = optionalServices;
    this.device = null;
    this.status = Status.IDLE;
    this._retry = 0;
    this._retryTimer = null;
    this._onDisconnect = () => this._handleDisconnect();
  }

  _setStatus(s, detail = '') {
    this.status = s;
    this.dispatchEvent(new CustomEvent('status', { detail: { status: s, detail } }));
  }

  /** Try a device Chrome already granted (no picker). Returns true if found. */
  async restore() {
    if (!navigator.bluetooth?.getDevices) return false;
    try {
      const known = await navigator.bluetooth.getDevices();
      const match = known.find((d) => this.matches(d.name || ''));
      if (!match) return false;
      this._attach(match);
      await this._connect();
      return true;
    } catch {
      return false;
    }
  }

  matches(name) {
    return this.filters.some((f) => (f.namePrefix && name.startsWith(f.namePrefix)) || (f.name && name === f.name));
  }

  /** Show Chrome's picker. Must be called from a user gesture. */
  async pick() {
    const dev = await navigator.bluetooth.requestDevice({
      filters: this.filters,
      optionalServices: this.optionalServices,
    });
    this._attach(dev);
    await this._connect();
  }

  _attach(dev) {
    if (this.device) this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    this.device = dev;
    dev.addEventListener('gattserverdisconnected', this._onDisconnect);
  }

  async _connect() {
    clearTimeout(this._retryTimer);
    this._setStatus(Status.CONNECTING);
    try {
      const server = await this.device.gatt.connect();
      await this.setup(server);
      this._retry = 0;
      this._setStatus(Status.CONNECTED, this.device.name);
      this.dispatchEvent(new Event('ready'));
    } catch (err) {
      console.warn(`[${this.key}] connect failed`, err);
      this._scheduleRetry();
    }
  }

  _handleDisconnect() {
    this.teardown();
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (!this.device) return;
    this._setStatus(Status.LOST);
    const delay = Math.min(1000 * 2 ** this._retry, 15000); // 1s, 2s, 4s … 15s
    this._retry++;
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  get connected() {
    return this.status === Status.CONNECTED;
  }

  // --- subclass hooks ---
  async setup(_server) {}
  teardown() {}
  async applyState(_state) {}
}
