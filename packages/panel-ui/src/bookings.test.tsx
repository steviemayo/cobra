import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PanelSettings, type Meeting, type PanelClient, type PanelViewModel } from '@kestrel/model';
import { PanelApp } from './PanelApp';

const NOW = new Date('2026-09-28T09:30:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const clock = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(NOW.getTime() + ms),
  );
const MIN = 60_000;

const meeting = (id: string, from: number, to: number, over: Partial<Meeting> = {}): Meeting => ({
  id,
  title: `Review ${id}`,
  organiser: 'Sam Lee',
  start: at(from),
  end: at(to),
  private: false,
  ...over,
});

const vm = (ui?: PanelViewModel['ui']): PanelViewModel => ({
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
      sources: [],
    },
  ],
  volume: { available: true, level: 50, muted: false },
  message: { text: { key: 'room_off', params: {} }, tone: 'info' },
  prompt: null,
  warning: null,
  ui,
});
const client = (v: PanelViewModel): PanelClient => ({
  getSnapshot: () => v,
  subscribe: () => () => undefined,
  dispatch: () => undefined,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('bookings on the panel', () => {
  it('shows nothing while the bookings are not known', () => {
    const { rerender } = render(<PanelApp client={client(vm())} schedule={null} />);
    expect(document.querySelector('.kp-booking')).toBeNull();
    rerender(<PanelApp client={client(vm())} />);
    expect(document.querySelector('.kp-booking')).toBeNull();
  });

  it('shows the meeting that is on: title, organiser, start and end, then when the room is next free', () => {
    render(<PanelApp client={client(vm())} schedule={[meeting('a', -30 * MIN, 30 * MIN)]} />);
    const bar = document.querySelector('.kp-booking')!;
    expect(bar.textContent).toContain('In use');
    expect(bar.textContent).toContain('Review a');
    expect(bar.textContent).toContain('Organised by Sam Lee');
    expect(bar.textContent).toContain(`${clock(-30 * MIN)} – ${clock(30 * MIN)}`);
    expect(bar.textContent).toContain(`Next available at: ${clock(30 * MIN)}`);
  });

  it('gives the end of the last of back-to-back meetings as when the room is next free', () => {
    render(
      <PanelApp
        client={client(vm())}
        schedule={[meeting('a', -30 * MIN, 30 * MIN), meeting('b', 30 * MIN, 90 * MIN)]}
      />,
    );
    expect(document.querySelector('.kp-booking')!.textContent).toContain(
      `Next available at: ${clock(90 * MIN)}`,
    );
  });

  it('says the room is available and when the next meeting is', () => {
    render(
      <PanelApp client={client(vm())} schedule={[meeting('b', 2 * 60 * MIN, 3 * 60 * MIN)]} />,
    );
    const bar = document.querySelector('.kp-booking')!;
    expect(bar.textContent).toContain('Available');
    expect(bar.textContent).toContain(`Next meeting at: ${clock(2 * 60 * MIN)}`);
    expect(bar.textContent).not.toContain('Review b');
  });

  it('just says available when nothing more is booked', () => {
    render(<PanelApp client={client(vm())} schedule={[]} />);
    const bar = document.querySelector('.kp-booking')!;
    expect(bar.textContent).toContain('Available');
    expect(bar.textContent).not.toContain('Next');
  });

  it('shows a private meeting as private, with no title or organiser', () => {
    render(
      <PanelApp
        client={client(vm())}
        schedule={[
          meeting('p', -10 * MIN, 20 * MIN, { title: '', organiser: undefined, private: true }),
        ]}
      />,
    );
    const bar = document.querySelector('.kp-booking')!;
    expect(bar.textContent).toContain('Private meeting');
    expect(bar.textContent).not.toContain('Organised by');
    expect(bar.textContent).toContain(`${clock(-10 * MIN)} – ${clock(20 * MIN)}`);
  });

  it('moves on by itself when a meeting ends', () => {
    render(<PanelApp client={client(vm())} schedule={[meeting('a', -30 * MIN, 5 * MIN)]} />);
    expect(document.querySelector('.kp-booking')!.textContent).toContain('In use');
    act(() => {
      vi.advanceTimersByTime(6 * MIN);
    });
    expect(document.querySelector('.kp-booking')!.textContent).toContain('Available');
  });

  it('also shows on the touch-to-begin screen', () => {
    render(
      <PanelApp
        client={client(vm(PanelSettings.parse({ idle: { timeoutMinutes: 1 } })))}
        schedule={[meeting('a', -30 * MIN, 30 * MIN)]}
      />,
    );
    const card = document.querySelector('.kp-idle .kp-booking-card')!;
    expect(card.textContent).toContain('Review a');
    expect(card.textContent).toContain(`Next available at: ${clock(30 * MIN)}`);
    expect(screen.getByRole('button', { name: 'Touch to begin' })).toBeTruthy();
  });

  it('is translated', () => {
    render(
      <PanelApp
        client={client(vm())}
        language="fr"
        schedule={[meeting('a', -30 * MIN, 30 * MIN)]}
      />,
    );
    const text = document.querySelector('.kp-booking')!.textContent!;
    expect(text).toContain('Occupée');
    expect(text).toContain('Organisée par Sam Lee');
    expect(text).toContain('Prochaine disponibilité');
  });
});
