import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type PanelClient, type PanelIntent, type PanelViewModel } from '@kestrel/model';
import { PanelApp } from './PanelApp';
import { createTranslator, messageText } from './i18n';
import { lightTheme, themeStyle } from './theme';

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
      id: 'record',
      name: 'Record',
      kind: 'record',
      active: false,
      busy: false,
      overlay: true,
      sources: [],
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

const on = (over: Partial<PanelViewModel> = {}): PanelViewModel => {
  const vm = base();
  vm.status = 'on';
  vm.activities[0]!.active = true;
  vm.activities[0]!.sources[0]!.selected = true;
  vm.activities[2]!.active = false;
  vm.message = { text: { key: 'presenting', params: { source: 'Laptop 1' } }, tone: 'success' };
  return { ...vm, ...over };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('when the room is off', () => {
  it('shows the room name and one big button per activity, with a quiet top bar', () => {
    const { client } = fakeClient(base());
    const view = render(<PanelApp client={client} />);
    expect(screen.getByRole('heading', { name: 'Boardroom' })).toBeTruthy();
    // Nothing in the top bar but the room name: no status badge, no Home, no Power.
    const top = view.container.querySelector('.kp-top')!;
    expect(top.classList.contains('kp-top-quiet')).toBe(true);
    expect(top.querySelectorAll('button')).toHaveLength(0);
    expect(top.querySelector('.kp-pill')).toBeNull();
    expect(screen.getByText('What would you like to do?')).toBeTruthy();
    // No device jargon, and no volume until the room is on.
    expect(screen.queryByRole('group', { name: 'Volume' })).toBeNull();
  });

  it('one tap on Present starts it with the source that already has a cable', () => {
    const { client, dispatched } = fakeClient(base());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Present/ }).at(-1)!);
    expect(dispatched).toEqual([
      { type: 'activity.start', activityId: 'present', sourceId: 'laptop2' },
    ]);
  });

  it('falls back to the first source when none has a cable', () => {
    const vm = base();
    vm.activities[0]!.sources.forEach((s) => (s.present = false));
    const { client, dispatched } = fakeClient(vm);
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Present/ }).at(-1)!);
    expect(dispatched[0]).toMatchObject({ sourceId: 'laptop1' });
  });
});

describe('when the room is on', () => {
  it('shows sources with plain-language cable status and the current one selected', () => {
    const { client } = fakeClient(on());
    render(<PanelApp client={client} />);
    expect(screen.getByText('Showing Laptop 1.')).toBeTruthy();
    const laptop1 = screen.getByRole('button', { name: /Laptop 1/ });
    expect(laptop1.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('No cable')).toBeTruthy();
    expect(screen.getByText('Cable connected')).toBeTruthy();
  });

  it('tapping another source selects it', () => {
    const { client, dispatched } = fakeClient(on());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: /Laptop 2/ }));
    expect(dispatched).toEqual([
      { type: 'activity.start', activityId: 'present', sourceId: 'laptop2' },
    ]);
  });

  it('Room Off is not a nav item: it is the Power button', () => {
    const { client } = fakeClient(on());
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('button', { name: 'Room Off' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Power' })).toBeTruthy();
  });

  it('Record toggles: start, then stop', () => {
    const { client, dispatched, set } = fakeClient(on());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(dispatched.at(-1)).toMatchObject({ type: 'activity.start', activityId: 'record' });
    const recording = on();
    recording.activities[1]!.active = true;
    set(recording);
    expect(screen.getByRole('button', { name: /Stop recording/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
    expect(dispatched.at(-1)).toEqual({ type: 'activity.stop', activityId: 'record' });
  });

  it('follows changes pushed by the runtime (another panel acted)', () => {
    const { client, set } = fakeClient(on());
    render(<PanelApp client={client} />);
    const changed = on();
    changed.activities[0]!.sources = [
      { id: 'laptop1', label: 'Laptop 1', present: false, selected: false },
      { id: 'laptop2', label: 'Laptop 2', present: true, selected: true },
    ];
    changed.message = {
      text: { key: 'presenting', params: { source: 'Laptop 2' } },
      tone: 'success',
    };
    set(changed);
    expect(screen.getByText('Showing Laptop 2.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Laptop 2/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows progress while starting', () => {
    const vm = on({ status: 'starting' });
    vm.message = { text: { key: 'starting', params: {} }, tone: 'progress' };
    const { client } = fakeClient(vm);
    render(<PanelApp client={client} />);
    expect(screen.getByText('Getting the room ready…')).toBeTruthy();
  });

  it('names a failing device in plain language', () => {
    const vm = on({ status: 'fault' });
    vm.message = { text: { key: 'fault_device', params: { device: 'Display 2' } }, tone: 'error' };
    const { client } = fakeClient(vm);
    render(<PanelApp client={client} />);
    expect(
      screen.getByText("Display 2 isn't responding. Try again, or contact support."),
    ).toBeTruthy();
  });
});

describe('volume', () => {
  const vol = (level: number, feedback: boolean, muted = false) =>
    on({ volume: { available: true, level, muted, feedback } });

  it('a tap bumps by 5', () => {
    const { client, dispatched } = fakeClient(on());
    render(<PanelApp client={client} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Volume up' }));
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Volume up' }));
    expect(dispatched).toEqual([{ type: 'volume.bump', delta: 5 }]);
  });

  it('has no slider, and shows no level until it changes', () => {
    const { client } = fakeClient(vol(50, true));
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(document.querySelector('.kp-hud')).toBeNull();
  });

  it('shows the level briefly when it changes, then hides it', () => {
    const { client, set } = fakeClient(vol(50, true));
    render(<PanelApp client={client} />);
    set(vol(55, true));
    expect(document.querySelector('.kp-hud-number')?.textContent).toBe('55');
    act(() => void vi.advanceTimersByTime(1600));
    expect(document.querySelector('.kp-hud')).toBeNull();
  });

  it('hides the number when no device reports its level', () => {
    const { client, set } = fakeClient(vol(50, false));
    render(<PanelApp client={client} />);
    set(vol(55, false));
    expect(document.querySelector('.kp-hud')).toBeTruthy();
    expect(document.querySelector('.kp-hud-number')).toBeNull();
  });

  it('press-and-hold ramps until released', () => {
    const { client, dispatched } = fakeClient(on());
    render(<PanelApp client={client} />);
    const down = screen.getByRole('button', { name: 'Volume down' });
    fireEvent.pointerDown(down);
    expect(dispatched).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(419));
    expect(dispatched).toHaveLength(1); // still just the tap
    act(() => void vi.advanceTimersByTime(1 + 270));
    expect(dispatched.length).toBeGreaterThanOrEqual(3);
    expect(dispatched.at(-1)).toEqual({ type: 'volume.bump', delta: -3 });
    fireEvent.pointerUp(down);
    const n = dispatched.length;
    act(() => void vi.advanceTimersByTime(1000));
    expect(dispatched).toHaveLength(n);
  });

  it('mute toggles and reflects state', () => {
    const { client, dispatched, set } = fakeClient(on());
    render(<PanelApp client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(dispatched).toEqual([{ type: 'mute.set', muted: true }]);
    set(on({ volume: { available: true, level: 50, muted: true } }));
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.querySelector('.kp-hud-text')?.textContent).toBe('Muted');
  });

  it('is hidden when the room has nothing to control volume', () => {
    const { client } = fakeClient(on({ volume: { available: false, level: 0, muted: false } }));
    render(<PanelApp client={client} />);
    expect(screen.queryByRole('group', { name: 'Volume' })).toBeNull();
  });
});

describe('prompts and warnings', () => {
  it('asks to switch source, with a countdown, and sends the answer', () => {
    const vm = on({
      prompt: {
        id: 'p1',
        text: { key: 'switch_source', params: { source: 'Laptop 2' } },
        secondsLeft: 8,
      },
    });
    const { client, dispatched } = fakeClient(vm);
    render(<PanelApp client={client} />);
    expect(screen.getByText('Laptop 2 was just plugged in. Switch to it?')).toBeTruthy();
    expect(screen.getByText('Switching in 8s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
    expect(dispatched).toEqual([
      { type: 'prompt.respond', promptId: 'p1', accept: true },
      { type: 'prompt.respond', promptId: 'p1', accept: false },
    ]);
  });

  it('warns before turning off and lets someone stay on', () => {
    const vm = on({ warning: { text: { key: 'auto_off', params: {} }, secondsLeft: 21 } });
    const { client, dispatched } = fakeClient(vm);
    render(<PanelApp client={client} />);
    expect(screen.getByText('Turning off in 21s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay on' }));
    expect(dispatched).toEqual([{ type: 'warning.dismiss' }]);
  });
});

describe('translation and theming', () => {
  it('uses another language, falling back to English for anything missing', () => {
    const t = createTranslator({ ready: 'Bereit.', 'volume.label': 'Lautstärke' });
    expect(messageText(t, { key: 'ready', params: {} })).toBe('Bereit.');
    expect(messageText(t, { key: 'starting', params: {} })).toBe('Getting the room ready…');
    const vm = on({ message: { text: { key: 'ready', params: {} }, tone: 'success' } });
    const { client } = fakeClient(vm);
    render(<PanelApp client={client} translate={t} />);
    expect(screen.getByText('Bereit.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Lautstärke' })).toBeTruthy();
  });

  it('fills placeholders and tolerates missing params', () => {
    const t = createTranslator();
    expect(t('presenting', { source: 'Laptop 1' })).toBe('Showing Laptop 1.');
    expect(t('presenting')).toBe('Showing .');
  });

  it('applies an organisation theme through CSS variables', () => {
    const style = themeStyle({ ...lightTheme, accent: '#ff0066', logoUrl: 'x.png' }) as Record<
      string,
      string
    >;
    expect(style['--kp-accent']).toBe('#ff0066');
    expect(style['--kp-bg']).toBe('#f4f6f8');
    const { client } = fakeClient(base());
    const { container } = render(
      <PanelApp client={client} theme={{ ...lightTheme, logoUrl: 'logo.png' }} />,
    );
    expect(container.querySelector('.kp-app')!.getAttribute('data-mode')).toBe('light');
    expect(container.querySelector('img.kp-logo')!.getAttribute('src')).toBe('logo.png');
  });
});
