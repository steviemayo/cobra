'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelBranding, PanelClient, PanelIntent, PanelViewModel } from '@kestrel/model';
import { EMPTY_VIEW, PanelApp, themeFromBranding } from '@kestrel/panel-ui';
import '@kestrel/panel-ui/panel.css';

class PhonePanelClient implements PanelClient {
  private vm: PanelViewModel = EMPTY_VIEW;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly send: (intent: PanelIntent) => void) {}
  set(vm: PanelViewModel) {
    this.vm = vm;
    for (const l of this.listeners) l();
  }
  getSnapshot() {
    return this.vm;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  dispatch(intent: PanelIntent) {
    this.send(intent);
  }
}

interface Stored {
  session: string;
  expiresAt: string;
}
const storeKey = (token: string) => `kestrel-phone:${token.split('.')[0]}`;
const read = (token: string): Stored | null => {
  try {
    const s = JSON.parse(sessionStorage.getItem(storeKey(token)) ?? 'null') as Stored | null;
    return s && new Date(s.expiresAt).getTime() > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
};
const write = (token: string, s: Stored) => {
  try {
    sessionStorage.setItem(storeKey(token), JSON.stringify(s));
  } catch {
    // Private browsing: the link still works for this visit.
  }
};

type Reply<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function post<T>(path: string, body: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok
      ? { ok: true, data: json as T }
      : { ok: false, status: res.status, error: json.error ?? 'Something went wrong' };
  } catch {
    return { ok: false, status: 0, error: 'Can’t reach Kestrel. Check your connection.' };
  }
}

interface State {
  vm: PanelViewModel | null;
  live: boolean;
  hasGateway: boolean;
  branding: PanelBranding;
}

const Message = ({ children }: { children: string }) => (
  <main className="grid min-h-dvh place-items-center bg-neutral-950 p-8 text-center text-neutral-100">
    <p className="max-w-xs text-lg">{children}</p>
  </main>
);

/** The room's control panel on a phone, opened from the QR code on the room's screen. */
export function PhoneControl({ token }: { token: string }) {
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    const saved = read(token);
    if (saved) {
      setSession(saved.session);
      return;
    }
    let cancelled = false;
    void post<Stored>('/api/phone/join', { token }).then((r) => {
      if (cancelled) return;
      if (!r.ok) return setError(r.error);
      write(token, r.data);
      setSession(r.data.session);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const tick = async () => {
      const r = await post<State>('/api/phone/state', { session });
      if (stopped) return;
      if (r.ok) setState(r.data);
      else if (r.status === 401 || r.status === 404) {
        setError(r.error);
        stopped = true;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [session]);

  const client = useMemo(
    () =>
      new PhonePanelClient((intent) => {
        const s = sessionRef.current;
        if (s) void post('/api/phone/intent', { session: s, intent });
      }),
    [],
  );
  useEffect(() => {
    if (state?.vm) client.set(state.vm);
  }, [state?.vm, client]);
  const theme = useMemo(() => themeFromBranding(state?.branding), [state?.branding]);

  if (error) return <Message>{error}</Message>;
  if (!state?.vm)
    return (
      <Message>
        {state && !state.hasGateway
          ? 'This room can’t be controlled from a phone yet.'
          : 'Connecting to the room… this can take up to 30 seconds.'}
      </Message>
    );
  return (
    <div className="min-h-dvh bg-black">
      <PanelApp client={client} theme={theme} language={state.branding.language} className="min-h-dvh" />
      {!state.live && (
        <div className="kp-offline" role="status" data-mode={theme.mode}>
          Reconnecting to the room…
        </div>
      )}
    </div>
  );
}
