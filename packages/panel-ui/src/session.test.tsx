import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { STARTER_TEMPLATES, type PanelServerMessage, type PanelViewModel } from '@kestrel/model';
import { PanelSession } from './PanelSession';
import { EMPTY_VIEW, WsPanelClient } from './ws-client';

const ROOM = '33333333-3333-4333-8333-333333333331';
void STARTER_TEMPLATES;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  // Test helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: PanelServerMessage | string) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const vm = (over: Partial<PanelViewModel> = {}): PanelViewModel => ({
  ...EMPTY_VIEW,
  roomName: 'Boardroom',
  status: 'on',
  activities: [
    { id: 'present', name: 'Present', kind: 'present', active: true, busy: false, overlay: false, sources: [] },
  ],
  message: { text: { key: 'ready', params: {} }, tone: 'success' },
  ...over,
});
const branding = { mode: 'dark' as const, language: 'en' };
const hello = (pinRequired = false): PanelServerMessage => ({ t: 'hello', roomId: ROOM, pinRequired, branding });
const socket = () => FakeSocket.instances.at(-1)!;
const client = (opts = {}) =>
  new WsPanelClient('ws://gw/ws/room', { createSocket: (u) => new FakeSocket(u), minRetryMs: 100, maxRetryMs: 400, ...opts });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WsPanelClient', () => {
  it('goes live on hello, and exposes the latest view', () => {
    const c = client();
    expect(c.getConnection().state).toBe('connecting');
    socket().open();
    socket().receive(hello());
    expect(c.getConnection()).toMatchObject({ state: 'live', branding });
    socket().receive({ t: 'snapshot', vm: vm() });
    expect(c.getSnapshot().roomName).toBe('Boardroom');
  });

  it('notifies subscribers of view and connection changes separately', () => {
    const c = client();
    const view = vi.fn();
    const conn = vi.fn();
    c.subscribe(view);
    c.subscribeConnection(conn);
    socket().receive(hello());
    expect(conn).toHaveBeenCalled();
    expect(view).not.toHaveBeenCalled();
    socket().receive({ t: 'snapshot', vm: vm() });
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('only sends intents while live, and validates nothing itself (the gateway does)', () => {
    const c = client();
    socket().open();
    c.dispatch({ type: 'volume.bump', delta: 5 });
    expect(socket().sent).toEqual([]); // not live yet
    socket().receive(hello());
    c.dispatch({ type: 'volume.bump', delta: 5 });
    expect(socket().sent).toEqual([{ t: 'intent', intent: { type: 'volume.bump', delta: 5 } }]);
  });

  it('asks for a PIN, sends it, and goes live when snapshots start', () => {
    const c = client();
    socket().open();
    socket().receive(hello(true));
    expect(c.getConnection().state).toBe('pin_required');
    c.submitPin('4821');
    expect(socket().sent).toEqual([{ t: 'auth', pin: '4821' }]);
    socket().receive({ t: 'error', message: 'Wrong PIN.' });
    expect(c.getConnection()).toMatchObject({ state: 'pin_required', message: 'Wrong PIN.' });
    socket().receive({ t: 'snapshot', vm: vm() });
    expect(c.getConnection().state).toBe('live');
  });

  it('keeps the last view and reconnects with growing delays', () => {
    const c = client();
    socket().open();
    socket().receive(hello());
    socket().receive({ t: 'snapshot', vm: vm() });
    socket().drop();
    expect(c.getConnection().state).toBe('reconnecting');
    expect(c.getSnapshot().roomName).toBe('Boardroom'); // still on screen
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    socket().drop(); // never opened: keeps backing off
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    socket().open();
    socket().receive(hello());
    expect(c.getConnection().state).toBe('live');
    socket().drop();
    vi.advanceTimersByTime(100); // backoff reset after a successful connection
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('caps the retry delay', () => {
    client();
    for (let i = 0; i < 6; i++) {
      socket().drop();
      vi.advanceTimersByTime(400);
    }
    expect(FakeSocket.instances).toHaveLength(7);
  });

  it('ignores garbage from the server and stops for good when closed', () => {
    const c = client();
    socket().receive('not json');
    socket().receive(JSON.stringify({ t: 'nonsense' }));
    expect(c.getConnection().state).toBe('connecting');
    c.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('works when its methods are passed around as callbacks', () => {
    const c = client();
    const { getSnapshot, subscribe, dispatch } = c;
    socket().receive(hello());
    socket().open();
    subscribe(() => undefined);
    dispatch({ type: 'volume.bump', delta: 1 });
    expect(getSnapshot()).toBe(EMPTY_VIEW);
    expect(socket().sent).toHaveLength(1);
  });
});

describe('PanelSession', () => {
  it('shows connecting, then the panel', () => {
    const c = client();
    render(<PanelSession client={c} />);
    expect(screen.getByText('Connecting to the room…')).toBeTruthy();
    act(() => {
      socket().open();
      socket().receive(hello());
      socket().receive({ t: 'snapshot', vm: vm() });
    });
    expect(screen.getByRole('heading', { name: 'Boardroom' })).toBeTruthy();
  });

  it('gates the panel behind a PIN keypad and submits what was entered', () => {
    const c = client();
    render(<PanelSession client={c} />);
    act(() => {
      socket().open();
      socket().receive(hello(true));
    });
    expect(screen.getByRole('heading', { name: 'Enter PIN' })).toBeTruthy();
    for (const d of ['4', '8', '2', '1']) fireEvent.click(screen.getByRole('button', { name: d }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(socket().sent).toEqual([{ t: 'auth', pin: '4821' }]);
    act(() => socket().receive({ t: 'error', message: 'Wrong PIN.' }));
    expect(screen.getByRole('alert').textContent).toBe('Wrong PIN.');
  });

  it('cannot submit an empty PIN, and Clear starts over', () => {
    const c = client();
    render(<PanelSession client={c} />);
    act(() => {
      socket().open();
      socket().receive(hello(true));
    });
    const unlock = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement;
    expect(unlock.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '7' }));
    expect(unlock.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(unlock.disabled).toBe(true);
  });

  it('keeps the panel visible with a banner while reconnecting', () => {
    const c = client();
    render(<PanelSession client={c} />);
    act(() => {
      socket().open();
      socket().receive(hello());
      socket().receive({ t: 'snapshot', vm: vm() });
    });
    act(() => socket().drop());
    expect(screen.getByRole('heading', { name: 'Boardroom' })).toBeTruthy();
    expect(screen.getByText('Reconnecting to the room…')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(100));
    act(() => {
      socket().open();
      socket().receive(hello());
    });
    expect(screen.queryByText('Reconnecting to the room…')).toBeNull();
  });

  it('applies the room branding', () => {
    const c = client();
    const { container } = render(<PanelSession client={c} />);
    act(() => {
      socket().open();
      socket().receive({ t: 'hello', roomId: ROOM, pinRequired: false, branding: { mode: 'light', accent: '#ff0066', language: 'en' } });
      socket().receive({ t: 'snapshot', vm: vm() });
    });
    const app = container.querySelector('.kp-app') as HTMLElement;
    expect(app.getAttribute('data-mode')).toBe('light');
    expect(app.style.getPropertyValue('--kp-accent')).toBe('#ff0066');
  });
  it('offers a QR code for phones once the room sends a link, and keeps the newest one', () => {
    const c = client();
    const { container } = render(<PanelSession client={c} />);
    act(() => {
      socket().open();
      socket().receive(hello());
      socket().receive({ t: 'snapshot', vm: vm() });
    });
    expect(screen.queryByLabelText('Control from your phone')).toBeNull();
    const link = (n: number): PanelServerMessage => ({ t: 'qr', url: `https://k.example/c/token${n}`, expiresAt: '2030-01-01T00:00:00.000Z' });
    act(() => {
      socket().receive(link(1));
      socket().receive(link(2));
    });
    expect(container.querySelector('.kp-qr')).toBeNull();
    fireEvent.click(screen.getByLabelText('Control from your phone'));
    expect(container.querySelector('svg.kp-qr path')).not.toBeNull();
    expect(c.getConnection().qr?.url).toBe('https://k.example/c/token2');
    fireEvent.click(screen.getByText('Close'));
    expect(container.querySelector('.kp-qr')).toBeNull();
  });
});
