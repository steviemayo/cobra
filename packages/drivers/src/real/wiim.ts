import type { DeviceDetailSection } from '@kestrel/model';
import { cleanText, clampVolume, MusicPlayerDriver, nowPlayingSection, type PlayerReading } from './music-player';

// WiiM (Linkplay) network players: Mini, Pro, Pro Plus, Amp, Ultra, and Arylic and other Linkplay
// boards. Monitoring only, over the player's own HTTP API: GET /httpapi.asp?command=<name>.
//   getPlayerStatus  playback state, source (mode), volume, mute and the track, with Title, Artist
//                    and Album hex-encoded (UTF-8)
//   getMetaInfo      the track again in plain text, with sample rate and bit depth
//   getStatusEx      name, model, firmware, MAC, Wi-Fi signal
// WiiM's own documentation says HTTPS on 443 with a self-signed certificate; older firmware and the
// forum thread also answer on plain HTTP port 80, so protocol and port are settings.
//
// Settings: host, protocol ("https"), port (443), allowSelfSigned (true), pollMs (5000), timeoutMs (4000).
//
// NOT YET VERIFIED AGAINST A REAL PLAYER. Field names come from WiiM's API list and the Linkplay
// documentation. Anything unrecognised (a mode number, a status word) is shown as the player wrote
// it rather than guessed at.

const PLAYBACK: Record<string, string> = {
  play: 'playing',
  pause: 'paused',
  stop: 'stopped',
  load: 'buffering',
};

/** Linkplay's `mode` numbers. Unknown numbers read as "Source N". */
const MODES: Record<string, string> = {
  '0': 'Idle',
  '1': 'AirPlay',
  '2': 'DLNA',
  '10': 'Network stream',
  '11': 'USB disk',
  '20': 'Streamed to the player',
  '31': 'Spotify Connect',
  '32': 'Tidal Connect',
  '40': 'Line in',
  '41': 'Bluetooth',
  '43': 'Optical',
  '47': 'Line in 2',
  '51': 'USB DAC',
  '99': 'Following another player',
};

/** Title, Artist and Album arrive as the hex of their UTF-8 bytes. Anything that is not hex is kept as written. */
export function decodeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(v)) return v;
  const text = cleanText(Buffer.from(v, 'hex').toString('utf8'));
  return text || undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.trim() || undefined : typeof v === 'number' ? String(v) : undefined;

/** Radio and some services fill a field with a placeholder ("unknown", "unknow") rather than leaving it empty. */
const real = (v: string | undefined): string | undefined =>
  v && !/^(unknown?|null|n\/a|-+)$/i.test(v) ? v : undefined;

/** `vendor` names the service behind a network stream ("newTuneIn", "Qobuz"). */
const vendorName = (v: string | undefined): string | undefined =>
  v ? v.replace(/^new(?=[A-Z])/, '') : undefined;

function parse(body: string): Record<string, unknown> {
  const v: unknown = JSON.parse(body);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('unexpected reply');
  return v as Record<string, unknown>;
}

const STATUS_EX_REFRESH_MS = 5 * 60_000;

export class WiimDriver extends MusicPlayerDriver {
  protected readonly defaultPort = 443;
  protected readonly defaultProtocol = 'https' as const;
  private identity: { at: number; section?: DeviceDetailSection; firmware?: string } | null = null;

  private command(name: string) {
    return this.get(`/httpapi.asp?command=${name}`);
  }

  /** The player's identity changes rarely, so it is read once in a while rather than every poll. */
  private async readIdentity() {
    if (this.identity && Date.now() - this.identity.at < STATUS_EX_REFRESH_MS) return this.identity;
    try {
      const ex = parse(await this.command('getStatusEx'));
      const rows: DeviceDetailSection['rows'] = [];
      const add = (label: string, value: string | undefined) => {
        if (value) rows.push({ label, value });
      };
      add('Name', str(ex.DeviceName));
      add('Model', str(ex.project));
      add('Hardware', str(ex.hardware));
      add('Firmware', str(ex.firmware));
      add('MAC address', str(ex.MAC));
      // A wired player reports 0, which is not a signal.
      const rssi = Number(ex.RSSI);
      add('Wi-Fi signal', rssi < 0 ? `${rssi} dBm` : undefined);
      this.identity = {
        at: Date.now(),
        section: rows.length ? { title: 'Player', rows } : undefined,
        firmware: str(ex.firmware),
      };
    } catch {
      // Keep whatever was known and try again at the next refresh.
      this.identity = { at: Date.now(), ...(this.identity ? { section: this.identity.section, firmware: this.identity.firmware } : {}) };
    }
    return this.identity;
  }

  protected async read(): Promise<PlayerReading> {
    const status = parse(await this.command('getPlayerStatus'));
    const identity = await this.readIdentity();

    // Plain-text metadata with the quality of the stream. Not every source has it.
    let meta: Record<string, unknown> = {};
    try {
      const m = parse(await this.command('getMetaInfo')).metaData;
      if (m && typeof m === 'object' && !Array.isArray(m)) meta = m as Record<string, unknown>;
    } catch {
      /* optional */
    }

    const raw = str(status.status)?.toLowerCase();
    const playback = raw ? (PLAYBACK[raw] ?? raw) : undefined;
    const mode = str(status.mode);
    // Mode 10 is a network stream: name the service (TuneIn, Qobuz...) when the player says which.
    const source = mode
      ? mode === '10'
        ? (vendorName(real(str(status.vendor))) ?? MODES[mode])
        : (MODES[mode] ?? `Source ${mode}`)
      : undefined;

    // Which tracks are "playing" only means something while the player is not stopped.
    const active = playback === 'playing' || playback === 'paused' || playback === 'buffering';
    const title = real(decodeHex(status.Title)) ?? real(str(meta.title));
    const artist = real(decodeHex(status.Artist)) ?? real(str(meta.artist));
    const album = real(decodeHex(status.Album)) ?? real(str(meta.album));
    // A radio station's name arrives as the subtitle.
    const station = real(str(meta.subtitle));
    const rate = str(meta.sampleRate);
    const depth = str(meta.bitDepth);
    const quality =
      rate && depth ? `${Number(rate) ? Number(rate) / 1000 : rate} kHz / ${depth} bit` : undefined;

    const volume = clampVolume(Number(status.vol));
    const details: DeviceDetailSection[] = [
      nowPlayingSection({
        state: playback,
        ...(active ? { station, title, artist, album, quality } : {}),
        source,
      }),
    ];
    if (identity?.section) details.push(identity.section);

    return {
      playback,
      playSource: source,
      volume,
      muted: status.mute === '1' || status.mute === 1 ? true : status.mute === '0' || status.mute === 0 ? false : undefined,
      firmware: identity?.firmware,
      details,
    };
  }
}
