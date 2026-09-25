import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  PanelSettings,
  type PanelClient,
  type PanelIntent,
  type PanelViewModel,
} from '@kestrel/model';
import { PanelApp } from './PanelApp';

const settings = (over: Record<string, unknown>) => PanelSettings.parse(over);

const base = (): PanelViewModel => ({
  roomName: 'Boardroom',
  status: 'off',
  activities: [
    {
      id: 'present',
      name: 'Present',
      kind: 'present',
      active: false,
      busy: false,
      overlay: false,
      sources: [
        { id: 'laptop1', label: 'Laptop 1', present: false, selected: false },
        { id: 'laptop2', label: 'Laptop 2', present: true, selected: false },
      ],
    },
    {
      id: 'room_off',
      name: 'Room Off',
      kind: 'room_off',
      active: true,
      busy: false,
      overlay: false,
      sources: [],
    },
  ],
  volume: { available: true, level: 50, muted: false },
  message: { text: { key: 'room_off', params: {} }, tone: 'info' },
  prompt: null,
  warning: null,
});

const running = (over: Partial<PanelViewModel> = {}): PanelViewModel => {
  const vm = base();
  vm.status = 'on';
  vm.activities[0]!.active = true;
  vm.activities[0]!.sources[0]!.selected = true;
  vm.activities[1]!.active = false;
  vm.message = { text: { key: 'presenting', params: { source: 'Laptop 1' } }, tone: 'success' };
  return { ...vm, ...over };
};

function fakeClient(vm: PanelViewModel) {
  const dispatched: PanelIntent[] = [];
  const listeners = new Set<() => void>();
  let snapshot = vm;
  const client: PanelClient = {
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispatch: (i) => void dispatched.push(i),
  };
  return {
    client,
    dispatched,
    set: (next: PanelViewModel) => {
      snapshot = next;
      act(() => listeners.forEach((l) => l()));
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('home screen', () => {
  it('tiles mode: no top nav, and Home opens the activity tiles', () => {
    const { client, dispatched } = fakeClient(running());
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('navigation', { name: 'Activities' })).toBeNull();
    expect(screen.queryByText('What’s happening today?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByText('What’s happening today?')).toBeTruthy();
    // Room Off is offered, as a quiet tile.
    fireEvent.click(screen.getByRole('button', { name: 'Room Off' }));
    expect(dispatched.at(-1)).toMatchObject({ type: 'activity.start', activityId: 'room_off' });
  });

  it('nav mode: top navigation, no Home button', () => {
    const { client } = fakeClient(running({ ui: settings({ homeMode: 'nav' }) }));
    render(<PanelApp client={client} />);
    expect(screen.getByRole('navigation', { name: 'Activities' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
  });

  it('always shows the time and room name in the bottom bar', () => {
    const { client } = fakeClient(base());
    render(<PanelApp client={client} />);
    expect(document.querySelector('.kp-bar .kp-clock-time')).toBeTruthy();
    expect(document.querySelector('.kp-bar .kp-clock-label')?.textContent).toBe('Boardroom');
  });
});

describe('quick actions', () => {
  const action = (id: string, active = false) => ({
    id,
    label: id === 'display.blank' ? 'Blank Screen' : id,
    icon: 'blank',
    kind: 'toggle' as const,
    active,
  });

  it('shows none when the room has none', () => {
    const { client } = fakeClient(running());
    render(<PanelApp client={client} />);
    expect(document.querySelectorAll('.kp-quick')).toHaveLength(0);
  });

  it('a toggle sends the opposite of its current state', () => {
    const { client, dispatched } = fakeClient(running({ quickActions: [action('display.blank')] }));
    render(<PanelApp client={client} />);
    const btn = screen.getByRole('button', { name: 'Blank Screen' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(dispatched.at(-1)).toEqual({
      type: 'quickaction.run',
      id: 'display.blank',
      active: true,
    });
  });

  it('keeps two in the bar and the rest in a sheet when there are more than three', () => {
    const { client, dispatched } = fakeClient(
      running({ quickActions: ['a', 'b', 'c', 'd'].map((id) => action(id)) }),
    );
    render(<PanelApp client={client} />);
    expect(screen.getByRole('button', { name: 'a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'b' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'c' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'c' }));
    expect(dispatched.at(-1)).toMatchObject({ type: 'quickaction.run', id: 'c' });
    expect(screen.queryByRole('dialog', { name: 'Quick actions' })).toBeNull();
  });
});

describe('touch to begin', () => {
  const withIdle = (over: Record<string, unknown> = {}, vm: PanelViewModel = base()) => ({
    ...vm,
    ui: settings({ idle: { timeoutMinutes: 1, ...over } }),
  });

  it('is not shown unless a timeout is set', () => {
    const { client } = fakeClient(base());
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('button', { name: 'Touch to begin' })).toBeNull();
  });

  it('shows on load, and a touch just wakes the panel by default', () => {
    const { client, dispatched } = fakeClient(withIdle());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Touch to begin' }));
    expect(screen.queryByRole('button', { name: 'Touch to begin' })).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('comes back after the timeout with no touches, and touches keep it away', () => {
    const { client } = fakeClient(withIdle());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Touch to begin' }));
    act(() => void vi.advanceTimersByTime(50_000));
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Boardroom' }));
    act(() => void vi.advanceTimersByTime(50_000));
    expect(screen.queryByRole('button', { name: 'Touch to begin' })).toBeNull();
    act(() => void vi.advanceTimersByTime(11_000));
    expect(screen.getByRole('button', { name: 'Touch to begin' })).toBeTruthy();
  });

  it('can start an activity when the room is off', () => {
    const { client, dispatched } = fakeClient(
      withIdle({ action: 'activity', activityId: 'present' }),
    );
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Touch to begin' }));
    expect(dispatched).toEqual([
      { type: 'activity.start', activityId: 'present', sourceId: 'laptop2' },
    ]);
  });

  it('can turn the room on, and leaves a running room alone', () => {
    const off = fakeClient(withIdle({ action: 'on' }));
    render(<PanelApp client={off.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Touch to begin' }));
    expect(off.dispatched).toEqual([{ type: 'room.on' }]);
    cleanup();

    const on = fakeClient(withIdle({ action: 'on' }, running()));
    render(<PanelApp client={on.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Touch to begin' }));
    expect(on.dispatched).toEqual([]);
  });

  it('never hides the auto-off warning behind it', () => {
    const { client, set } = fakeClient(withIdle({}, running()));
    render(<PanelApp client={client} />);
    expect(screen.getByRole('button', { name: 'Touch to begin' })).toBeTruthy();
    set({
      ...withIdle({}, running()),
      warning: { text: { key: 'auto_off', params: {} }, secondsLeft: 30 },
    });
    expect(screen.queryByRole('button', { name: 'Touch to begin' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stay on' })).toBeTruthy();
  });

  it('shows the support text and a QR code', () => {
    const { client } = fakeClient(
      withIdle({ supportText: 'Dial 9925 8000', supportUrl: 'https://help.example.com' }),
    );
    render(<PanelApp client={client} />);
    expect(screen.getByText('Dial 9925 8000')).toBeTruthy();
    expect(document.querySelector('.kp-idle .kp-qr')).toBeTruthy();
  });
});
