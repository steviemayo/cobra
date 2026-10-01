import type { DeviceDetailSection } from '@kestrel/model';
import { cleanText, clampVolume, MusicPlayerDriver, nowPlayingSection, type PlayerReading } from './music-player';

// Bluesound players running BluOS: Node, Powernode, Vault, Pulse and the Professional B100S and
// B400S. Monitoring only, over BluOS's own HTTP API on port 11000, which answers in XML:
//   GET /Status      state (play, pause, stop, stream), the track (name, artist, album, or the
//                    title1/2/3 display lines), the service, volume and mute
//   GET /SyncStatus  what the player is: name, model, brand, MAC, volume, and its group
// No login: BluOS has no authentication on this API.
//
// Settings: host, port (11000), pollMs (5000), timeoutMs (4000).
//
// NOT YET VERIFIED AGAINST A REAL PLAYER. The element and attribute names are from the BluOS custom
// integration API reference, and checked against a real B100S (BluOS 4.16.22): the software
// version is the `version` attribute on /SyncStatus. While a player installs an update both
// endpoints answer with an upgrade page instead, which reads as offline.

const PLAYBACK: Record<string, string> = {
  play: 'playing',
  stream: 'playing',
  pause: 'paused',
  stop: 'stopped',
  connecting: 'buffering',
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Text with XML entities and CDATA unwrapped. */
export function xmlText(raw: string): string {
  return cleanText(
    raw
      .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
          const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      }),
  );
}

/** The text of the first <name> element, or undefined when it is missing or empty. */
export function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  const v = m?.[1] === undefined ? undefined : xmlText(m[1]);
  return v || undefined;
}

/** The attributes of the first <name ...> element. */
export function attrs(xml: string, name: string): Record<string, string> {
  const open = new RegExp(`<${name}(\\s[^>]*)?/?>`, 'i').exec(xml)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of open.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = xmlText(m[2]!);
  return out;
}

const first = (...values: (string | undefined)[]) => values.find((v) => !!v);

export class BluesoundDriver extends MusicPlayerDriver {
  protected readonly defaultPort = 11000;
  protected readonly defaultProtocol = 'http' as const;

  protected async read(): Promise<PlayerReading> {
    const status = await this.get('/Status');
    if (!/<status[\s>]/i.test(status)) throw new Error('unexpected reply');
    // Who the player is. Best effort: a player that answers /Status but not /SyncStatus still reports.
    let sync = '';
    try {
      sync = await this.get('/SyncStatus');
    } catch {
      /* optional */
    }

    const raw = tag(status, 'state')?.toLowerCase();
    const playback = raw ? (PLAYBACK[raw] ?? raw) : undefined;
    const active = playback === 'playing' || playback === 'paused' || playback === 'buffering';

    // BluOS puts the track in name/artist/album for most services and in title1/2/3 for the rest
    // (a radio station, an input): the display lines carry the same thing in either case.
    const title = first(tag(status, 'title1'), tag(status, 'name'));
    const artist = first(tag(status, 'title2'), tag(status, 'artist'));
    const album = first(tag(status, 'title3'), tag(status, 'album'));
    const source = first(tag(status, 'serviceName'), tag(status, 'service'), tag(status, 'inputId'));
    const quality = first(tag(status, 'streamFormat'), tag(status, 'quality'));

    const volume = clampVolume(Number(tag(status, 'volume')));
    const mute = tag(status, 'mute');

    const details: DeviceDetailSection[] = [
      nowPlayingSection({
        state: playback,
        ...(active ? { title, artist, album, quality } : {}),
        source,
      }),
    ];

    const a = attrs(sync, 'SyncStatus');
    const firmware = first(a.version, a.bluos);
    const rows: DeviceDetailSection['rows'] = [];
    const add = (label: string, value: string | undefined) => {
      if (value) rows.push({ label, value });
    };
    add('Name', a.name);
    add('Brand', a.brand);
    add('Model', first(a.modelName, a.model));
    add('Software', firmware);
    add('MAC address', a.mac);
    const slaves = sync.match(/<slave[\s>]/gi)?.length ?? 0;
    const master = attrs(sync, 'master');
    const leader = tag(sync, 'master');
    if (leader || master.id) add('Group', `Follows ${leader ?? master.id}`);
    else if (slaves > 0) add('Group', `Leads ${slaves} other ${slaves === 1 ? 'player' : 'players'}`);
    if (rows.length) details.push({ title: 'Player', rows });

    return {
      playback,
      playSource: source,
      volume,
      muted: mute === '1' ? true : mute === '0' ? false : undefined,
      firmware,
      details,
    };
  }
}
