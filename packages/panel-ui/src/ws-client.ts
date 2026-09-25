import {
  PanelServerMessage,
  type PanelBranding,
  type PanelClient,
  type PanelIntent,
  type PanelViewModel,
} from '@kestrel/model';

export type ConnectionState = 'connecting' | 'pin_required' | 'live' | 'reconnecting' | 'error';

export interface Connection {
  state: ConnectionState;
  /** Server message worth showing, e.g. "Wrong PIN." */
  message?: string;
  branding?: PanelBranding;
  /** A link for controlling the room from a phone, replaced before it expires. */
  qr?: { url: string; expiresAt: string };
}

/** What a panel shows before the first snapshot arrives. */
export const EMPTY_VIEW: PanelViewModel = {
  roomName: '',
  status: 'off',
  activities: [],
  volume: { available: false, level: 0, muted: false },
  message: null,
  prompt: null,
  warning: null,
};

interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WsClientOptions {
  /** Injectable for tests. */
  createSocket?: (url: string) => SocketLike;
  minRetryMs?: number;
  maxRetryMs?: number;
}

const OPEN = 1;

/**
 * A PanelClient backed by a gateway WebSocket. Reconnects with backoff, so a gateway restart or a
 * new release just shows a brief "reconnecting" state, and it handles the PIN handshake.
 */
export class WsPanelClient implements PanelClient {
  private view: PanelViewModel = EMPTY_VIEW;
  private connection: Connection = { state: 'connecting' };
  private readonly viewListeners = new Set<() => void>();
  private readonly connectionListeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly min: number;
  private readonly max: number;

  constructor(
    private readonly url: string,
    private readonly opts: WsClientOptions = {},
  ) {
    this.min = opts.minRetryMs ?? 500;
    this.max = opts.maxRetryMs ?? 5000;
    // Callbacks are handed to React; keep `this` attached.
    this.getSnapshot = this.getSnapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.dispatch = this.dispatch.bind(this);
    this.getConnection = this.getConnection.bind(this);
    this.subscribeConnection = this.subscribeConnection.bind(this);
    this.open();
  }

  getSnapshot(): PanelViewModel {
    return this.view;
  }

  subscribe(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  getConnection(): Connection {
    return this.connection;
  }

  subscribeConnection(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  dispatch(intent: PanelIntent): void {
    if (this.connection.state !== 'live') return;
    this.send({ t: 'intent', intent });
  }

  submitPin(pin: string): void {
    this.send({ t: 'auth', pin });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  private send(msg: unknown) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private setConnection(next: Connection) {
    this.connection = { ...this.connection, message: undefined, ...next };
    for (const l of this.connectionListeners) l();
  }

  private open() {
    const socket = this.opts.createSocket
      ? this.opts.createSocket(this.url)
      : (new WebSocket(this.url) as unknown as SocketLike);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
    };
    socket.onmessage = (ev) => {
      let json: unknown;
      try {
        json = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const msg = PanelServerMessage.safeParse(json);
      if (!msg.success) return;
      switch (msg.data.t) {
        case 'hello':
          this.setConnection({
            state: msg.data.pinRequired ? 'pin_required' : 'live',
            branding: msg.data.branding,
          });
          break;
        case 'snapshot':
          this.view = msg.data.vm;
          if (this.connection.state !== 'live') this.setConnection({ state: 'live' });
          for (const l of this.viewListeners) l();
          break;
        case 'qr':
          this.setConnection({
            state: this.connection.state,
            qr: { url: msg.data.url, expiresAt: msg.data.expiresAt },
          });
          break;
        case 'error':
          this.setConnection({
            state: this.connection.state === 'pin_required' ? 'pin_required' : 'error',
            message: msg.data.message,
          });
          break;
      }
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.closed) return;
      // Keep the last view on screen while we try again.
      this.setConnection({ state: 'reconnecting' });
      const delay = Math.min(this.max, this.min * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}
