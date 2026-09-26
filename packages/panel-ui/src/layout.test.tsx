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

describe('function pages', () => {
  const functions = (over: Record<string, unknown> = {}) => ({
    cameras: [
      {
        id: 'ptz1',
        name: 'Front camera',
        presets: ['Wide', 'Podium'],
        activePreset: 'Wide',
        canMove: true,
      },
    ],
    microphones: [
      { id: 'mic1', name: 'Ceiling mic', muted: false },
      { id: 'mic2', name: 'Lectern mic', muted: null },
    ],
    lights: [{ id: 'lights1', name: 'Room lights', scenes: ['Bright', 'Dim'], active: 'Dim' }],
    movers: [
      {
        id: 'blinds1',
        name: 'Window blinds',
        kind: 'blinds' as const,
        actions: ['open' as const, 'close' as const],
      },
      {
        id: 'screen1',
        name: 'Projection screen',
        kind: 'screen' as const,
        actions: ['down' as const, 'up' as const],
      },
    ],
    displays: [],
    ...over,
  });
  const nav = (name: string) => screen.getByRole('button', { name });

  it('adds a page to the top nav for each thing the room offers', () => {
    const { client } = fakeClient(running({ functions: functions() }));
    render(<PanelApp client={client} />);
    for (const name of ['Cameras', 'Microphones', 'Room controls']) expect(nav(name)).toBeTruthy();
  });

  it('offers only the pages the room has', () => {
    const { client } = fakeClient(
      running({ functions: functions({ cameras: [], lights: [], movers: [], displays: [] }) }),
    );
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('button', { name: 'Cameras' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Room controls' })).toBeNull();
    expect(nav('Microphones')).toBeTruthy();
  });

  it('shows none while the room is off, or when the room offers none', () => {
    const off = fakeClient({ ...base(), functions: functions() });
    render(<PanelApp client={off.client} />);
    expect(screen.queryByRole('button', { name: 'Cameras' })).toBeNull();
    cleanup();
    const none = fakeClient(running());
    render(<PanelApp client={none.client} />);
    expect(screen.queryByRole('button', { name: 'Cameras' })).toBeNull();
  });

  it('recalls a camera preset, and marks the one that is active', () => {
    const { client, dispatched } = fakeClient(running({ functions: functions() }));
    render(<PanelApp client={client} />);
    fireEvent.click(nav('Cameras'));
    expect(screen.getByRole('button', { name: 'Wide' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Podium' }));
    expect(dispatched.at(-1)).toEqual({
      type: 'camera.preset',
      deviceId: 'ptz1',
      preset: 'Podium',
    });
  });

  describe('pointing the camera', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const moves = (d: PanelIntent[]) => d.filter((i) => i.type === 'camera.move');
    const stop = { type: 'camera.move', deviceId: 'ptz1', pan: 0, tilt: 0, zoom: 0 };

    it('moves while a button is held, repeating, and stops on release', () => {
      const { client, dispatched } = fakeClient(running({ functions: functions() }));
      render(<PanelApp client={client} />);
      fireEvent.click(nav('Cameras'));
      const left = screen.getByRole('button', { name: 'Left' });
      fireEvent.pointerDown(left);
      expect(moves(dispatched)).toEqual([
        { type: 'camera.move', deviceId: 'ptz1', pan: -1, tilt: 0, zoom: 0 },
      ]);
      act(() => void vi.advanceTimersByTime(1100));
      expect(moves(dispatched)).toHaveLength(3); // pressed, then twice more while held
      fireEvent.pointerUp(left);
      expect(moves(dispatched).at(-1)).toEqual(stop);
      const after = moves(dispatched).length;
      act(() => void vi.advanceTimersByTime(2000));
      expect(moves(dispatched)).toHaveLength(after); // no more repeats
    });

    it('zooms and tilts with the other buttons', () => {
      const { client, dispatched } = fakeClient(running({ functions: functions() }));
      render(<PanelApp client={client} />);
      fireEvent.click(nav('Cameras'));
      for (const [name, pan, tilt, zoom] of [
        ['Up', 0, 1, 0],
        ['Down', 0, -1, 0],
        ['Right', 1, 0, 0],
        ['Zoom in', 0, 0, 1],
        ['Zoom out', 0, 0, -1],
      ] as const) {
        const b = screen.getByRole('button', { name });
        fireEvent.pointerDown(b);
        expect(moves(dispatched).at(-1), name).toEqual({
          type: 'camera.move',
          deviceId: 'ptz1',
          pan,
          tilt,
          zoom,
        });
        fireEvent.pointerUp(b);
      }
    });

    it('stops the camera if the page goes away while a button is held', () => {
      const { client, dispatched } = fakeClient(running({ functions: functions() }));
      render(<PanelApp client={client} />);
      fireEvent.click(nav('Cameras'));
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Right' }));
      fireEvent.click(nav('Microphones')); // leaves the camera page
      expect(moves(dispatched).at(-1)).toEqual(stop);
    });

    it('stops if the pointer is dragged off the button or interrupted', () => {
      const { client, dispatched } = fakeClient(running({ functions: functions() }));
      render(<PanelApp client={client} />);
      fireEvent.click(nav('Cameras'));
      const up = screen.getByRole('button', { name: 'Up' });
      fireEvent.pointerDown(up);
      fireEvent.pointerLeave(up);
      expect(moves(dispatched).at(-1)).toEqual(stop);
      fireEvent.pointerDown(up);
      fireEvent.pointerCancel(up);
      expect(moves(dispatched).at(-1)).toEqual(stop);
    });
  });

  it('mutes and unmutes microphones, showing state only when the microphone says', () => {
    const { client, dispatched } = fakeClient(running({ functions: functions() }));
    render(<PanelApp client={client} />);
    fireEvent.click(nav('Microphones'));
    expect(screen.getAllByText('Live')).toHaveLength(1); // the second microphone does not say
    fireEvent.click(screen.getByRole('button', { name: /Ceiling mic/ }));
    expect(dispatched.at(-1)).toEqual({ type: 'mic.mute', deviceId: 'mic1', muted: true });
    fireEvent.click(screen.getByRole('button', { name: /Lectern mic/ }));
    expect(dispatched.at(-1)).toEqual({ type: 'mic.mute', deviceId: 'mic2', muted: true });
  });

  it('room controls: lighting scenes and blinds and screens', () => {
    const { client, dispatched } = fakeClient(running({ functions: functions() }));
    render(<PanelApp client={client} />);
    fireEvent.click(nav('Room controls'));
    expect(screen.getByRole('button', { name: 'Dim' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Bright' }));
    expect(dispatched.at(-1)).toEqual({ type: 'scene.set', deviceId: 'lights1', scene: 'Bright' });
    const blinds = within(screen.getByRole('region', { name: 'Window blinds' }));
    fireEvent.click(blinds.getByRole('button', { name: 'Close' }));
    expect(dispatched.at(-1)).toEqual({ type: 'mover.run', deviceId: 'blinds1', action: 'close' });
    const screenCard = within(screen.getByRole('region', { name: 'Projection screen' }));
    fireEvent.click(screenCard.getByRole('button', { name: 'Lower' }));
    expect(dispatched.at(-1)).toEqual({ type: 'mover.run', deviceId: 'screen1', action: 'down' });
  });

  it('going back to an activity leaves the page, and a room that turns off drops it', () => {
    const { client, set } = fakeClient(running({ functions: functions() }));
    render(<PanelApp client={client} />);
    fireEvent.click(nav('Cameras'));
    expect(screen.getByRole('heading', { name: 'Cameras' })).toBeTruthy();
    fireEvent.click(nav('Present'));
    expect(screen.queryByRole('heading', { name: 'Cameras' })).toBeNull();
    fireEvent.click(nav('Cameras'));
    set({ ...base(), functions: functions() });
    expect(screen.queryByRole('heading', { name: 'Cameras' })).toBeNull();
  });
});

describe('display page', () => {
  const display = (over: Record<string, unknown> = {}) => ({
    id: 'tv1',
    name: 'Left screen',
    keys: true,
    media: true,
    apps: [
      { id: 'app.netflix', name: 'Netflix' },
      { id: 'app.signage', name: 'Signage' },
    ],
    activeApp: 'app.signage',
    ...over,
  });
  const withDisplays = (displays: unknown[]) =>
    running({
      functions: { cameras: [], microphones: [], lights: [], movers: [], displays } as never,
    });
  const keys = (dispatched: { type: string }[]) => dispatched.filter((i) => i.type === 'display.key');

  it('adds a Display page only when a display offers something', () => {
    const none = fakeClient(withDisplays([]));
    render(<PanelApp client={none.client} />);
    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull();
    cleanup();
    const some = fakeClient(withDisplays([display()]));
    render(<PanelApp client={some.client} />);
    expect(screen.getByRole('button', { name: 'Display' })).toBeTruthy();
  });

  it('launches an app and marks the one that is open', () => {
    const { client, dispatched } = fakeClient(withDisplays([display()]));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.getByRole('button', { name: 'Signage' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Netflix' }));
    expect(dispatched).toContainEqual({ type: 'display.app', deviceId: 'tv1', appId: 'app.netflix' });
  });

  it('presses keys, and an arrow repeats while it is held', () => {
    const { client, dispatched } = fakeClient(withDisplays([display()]));
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(keys(dispatched)).toEqual([
      { type: 'display.key', deviceId: 'tv1', key: 'ok' },
      { type: 'display.key', deviceId: 'tv1', key: 'pause' },
    ]);
    const before = keys(dispatched).length;
    const down = screen.getByRole('button', { name: 'Down' });
    fireEvent.pointerDown(down);
    act(() => void vi.advanceTimersByTime(1100));
    fireEvent.pointerUp(down);
    expect(keys(dispatched).length - before).toBe(3);
    act(() => void vi.advanceTimersByTime(2000));
    expect(keys(dispatched).length - before).toBe(3);
  });

  it('shows only what the display supports, and names the display only when there are several', () => {
    const one = fakeClient(withDisplays([display({ keys: false, media: false })]));
    render(<PanelApp client={one.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Left screen' })).toBeNull();
    cleanup();
    const two = fakeClient(withDisplays([display(), display({ id: 'tv2', name: 'Right screen' })]));
    render(<PanelApp client={two.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.getByRole('heading', { name: 'Left screen' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Right screen' })).toBeTruthy();
  });
});

