import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('navigation and the start screen', () => {
  it('while the room is on, the activities are one row of top navigation with no Home button', () => {
    const { client } = fakeClient(running());
    render(<PanelApp client={client} />);
    const nav = screen.getByRole('navigation', { name: 'Activities' });
    expect(nav.querySelectorAll('button')).toHaveLength(1); // Present (Room Off is the Power button)
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
  });

  it('marks the current activity, and the highlight follows a change', () => {
    const vm = running();
    vm.activities.splice(1, 0, {
      id: 'call',
      name: 'Video call',
      kind: 'video_call',
      active: false,
      busy: false,
      overlay: false,
      sources: [],
    });
    const { client, dispatched } = fakeClient(vm);
    render(<PanelApp client={client} />);
    const present = screen.getByRole('button', { name: 'Present' });
    const call = screen.getByRole('button', { name: 'Video call' });
    expect(present.getAttribute('aria-pressed')).toBe('true');
    expect(call.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.kp-nav-anchor')).toBeTruthy();
    fireEvent.click(call);
    expect(dispatched.at(-1)).toMatchObject({ type: 'activity.start', activityId: 'call' });
    expect(call.getAttribute('aria-pressed')).toBe('true');
    expect(present.getAttribute('aria-pressed')).toBe('false');
  });

  it('while the room is off: no nav, no bottom bar, options in the middle', () => {
    const { client } = fakeClient(base());
    const view = render(<PanelApp client={client} />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(view.container.querySelector('.kp-bar')).toBeNull();
    expect(view.container.querySelector('.kp-quick')).toBeNull();
    expect(view.container.querySelector('.kp-main')!.classList.contains('kp-main-centre')).toBe(
      true,
    );
  });

  it('shows the time and room name in the bottom bar while on', () => {
    const { client } = fakeClient(running());
    render(<PanelApp client={client} />);
    expect(document.querySelector('.kp-bar .kp-clock-time')).toBeTruthy();
    expect(document.querySelector('.kp-bar .kp-clock-label')?.textContent).toBe('Boardroom');
  });
});

describe('what the room is doing', () => {
  it('is small print under the room name, not a banner', () => {
    const { client } = fakeClient(running());
    const view = render(<PanelApp client={client} />);
    const note = view.container.querySelector('.kp-brand .kp-note')!;
    expect(note.textContent).toBe('Showing Laptop 1.');
    expect(view.container.querySelector('.kp-banner')).toBeNull();
  });

  it('is left out on the start screen, where it would only repeat the heading', () => {
    const { client } = fakeClient(base());
    const view = render(<PanelApp client={client} />);
    expect(view.container.querySelector('.kp-note')).toBeNull();
  });

  it('still shows progress and problems, in their own colour', () => {
    const vm = running({ status: 'fault' });
    vm.message = { text: { key: 'fault_generic', params: {} }, tone: 'error' };
    const { client } = fakeClient(vm);
    const view = render(<PanelApp client={client} />);
    expect(view.container.querySelector('.kp-note-error')).toBeTruthy();
  });
});

describe('power', () => {
  it('has no Power button while the room is off', () => {
    const { client } = fakeClient(base());
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('button', { name: 'Power' })).toBeNull();
  });

  it('asks "Power off system?" and only turns the room off on confirm', () => {
    const { client, dispatched } = fakeClient(running());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Power' }));
    expect(screen.getByRole('alertdialog', { name: 'Power off system?' })).toBeTruthy();
    expect(dispatched).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Power off' }));
    expect(dispatched).toEqual([
      { type: 'activity.start', activityId: 'room_off', sourceId: undefined },
    ]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Cancel goes back without doing anything', () => {
    const { client, dispatched } = fakeClient(running());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Power' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('a touch outside the dialog, or Escape, goes back too', () => {
    const { client, dispatched } = fakeClient(running());
    const { container } = render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Power' }));
    fireEvent.click(container.querySelector('.kp-dialog-backdrop')!);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Power' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('a touch inside the dialog does not dismiss it', () => {
    const { client } = fakeClient(running());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Power' }));
    fireEvent.click(screen.getByRole('heading', { name: 'Power off system?' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('closes by itself if the room turns off meanwhile', () => {
    const { client, set } = fakeClient(running());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Power' }));
    set(base());
    expect(screen.queryByRole('alertdialog')).toBeNull();
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

  it('translates the standard actions by id, and shows any other label as given', () => {
    const { client } = fakeClient(
      running({ quickActions: [action('display.blank'), action('custom.thing')] }),
    );
    render(<PanelApp client={client} language="es" />);
    expect(screen.getByRole('button', { name: 'Pantalla en negro' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'custom.thing' })).toBeTruthy();
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

describe('linking rooms', () => {
  const wall = (over: Record<string, unknown> = {}) => ({
    id: 'w1',
    name: 'Wall 1',
    open: false,
    rooms: ['Room A', 'Room B'],
    adds: ['Room B'],
    available: true,
    ...over,
  });
  const linking = (dividers = [wall()], space = ['Room A']) => ({ dividers, space });

  it('is not offered to a room that is not in a group', () => {
    const { client } = fakeClient(running());
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('button', { name: 'Link rooms' })).toBeNull();
  });

  it('is offered even while the room is off, so rooms can be linked before starting', () => {
    const { client } = fakeClient({ ...base(), linking: linking() });
    render(<PanelApp client={client} />);
    expect(screen.getByRole('button', { name: 'Link rooms' })).toBeTruthy();
  });

  it('offers to combine with each neighbouring room, in words for the room, not the building', () => {
    const { client } = fakeClient(running({ linking: linking() }));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    const sheet = screen.getByRole('dialog', { name: 'Link rooms' });
    expect(sheet.textContent).toContain('Combine with Room B');
    expect(sheet.textContent).toContain('This room is on its own.');
    expect(sheet.textContent).not.toMatch(/wall/i);
  });

  it('a wall that joins two other rooms is one choice naming both', () => {
    const three = wall({ rooms: ['Large', 'Room B', 'Room C'], adds: ['Large', 'Room C'] });
    const { client } = fakeClient(running({ linking: linking([three], ['Room B']) }));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    expect(screen.getByText('Combine with Large + Room C')).toBeTruthy();
  });

  it('asks before combining, and only then sends it', () => {
    const { client, dispatched } = fakeClient(running({ linking: linking() }));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));
    expect(dispatched.some((i) => i.type === 'divider.set')).toBe(false);
    const ask = screen.getByRole('alertdialog');
    expect(ask.textContent).toContain('Combine with Room B?');
    expect(ask.textContent).toContain('work together as one');
    fireEvent.click(within(ask).getByRole('button', { name: 'Combine' }));
    expect(dispatched.at(-1)).toEqual({ type: 'divider.set', dividerId: 'w1', open: true });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cancelling the question changes nothing', () => {
    const { client, dispatched } = fakeClient(running({ linking: linking() }));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dispatched.some((i) => i.type === 'divider.set')).toBe(false);
  });

  it('linked rooms say so and offer to separate', () => {
    const { client, dispatched } = fakeClient(
      running({ linking: linking([wall({ open: true, adds: [] })], ['Room A', 'Room B']) }),
    );
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    const sheet = screen.getByRole('dialog', { name: 'Link rooms' });
    expect(sheet.textContent).toContain('Linked together: Room A + Room B');
    expect(sheet.textContent).toContain('Linked with Room A + Room B');
    fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    const ask = screen.getByRole('alertdialog');
    expect(ask.textContent).toContain('Each room will work on its own again.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Separate' }));
    expect(dispatched.at(-1)).toEqual({ type: 'divider.set', dividerId: 'w1', open: false });
  });

  it('a choice that cannot be made yet is disabled and says why', () => {
    const { client } = fakeClient(running({ linking: linking([wall({ available: false })]) }));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    expect((screen.getByRole('button', { name: 'Combine' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Not set up yet')).toBeTruthy();
  });

  it('drops a question that went stale because the rooms were linked meanwhile', () => {
    const { client, set } = fakeClient(running({ linking: linking() }));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link rooms' }));
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    set(running({ linking: linking([wall({ open: true, adds: [] })], ['Room A', 'Room B']) }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
