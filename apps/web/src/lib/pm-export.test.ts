import { describe, expect, it } from 'vitest';
import { visitsToCsv, visitsToHtml, type ExportVisit } from './pm-export';

const base = {
  templateName: 'Room check',
  status: 'signed',
  failedCount: 1,
  roomId: null,
  roomName: null,
  deviceId: null,
  deviceName: null,
  siteId: 's1',
  siteName: 'Head office',
  signedAt: new Date('2026-10-05T10:00:00Z'),
  signedByName: 'Sam "Tech" <script>',
  dueOn: new Date('2026-10-05T00:00:00Z'),
  createdAt: new Date('2026-10-05T09:00:00Z'),
  correctsRunId: null,
  parentRunId: null,
  parentLabel: null,
  notes: null,
} as const;

const visit: ExportVisit = {
  ...base,
  id: 'v1',
  multi: true,
  scopeLabel: 'Site: Head office',
  segments: [],
  sections: [
    {
      runId: 'r1',
      room: 'Boardroom',
      device: null,
      status: 'signed',
      failedCount: 1,
      skipReason: null,
      workedByName: 'Sam',
      results: [
        {
          itemId: 'picture',
          type: 'passfail',
          label: 'Picture, clear',
          result: 'fail',
          note: 'Flickers',
          kestrelSaw: null,
        },
        {
          itemId: 'audio',
          type: 'passfail',
          label: 'Audio',
          result: 'pass',
          note: null,
          kestrelSaw: 'All answering',
        },
        {
          itemId: 'rack',
          type: 'photo',
          label: 'Photo of the rack',
          result: null,
          note: null,
          kestrelSaw: null,
        },
      ],
      photos: [
        {
          id: 'p1',
          itemId: 'rack',
          itemLabel: 'Photo of the rack',
          mime: 'image/jpeg',
          size: 100,
          sha256: 'abcdef0123456789abcdef',
          createdAt: new Date('2026-10-05T10:00:00Z'),
        },
        {
          id: 'p2',
          itemId: 'rack',
          itemLabel: 'Photo of the rack',
          mime: 'image/png',
          size: 100,
          sha256: '0123456789abcdef0123',
          createdAt: new Date('2026-10-05T10:01:00Z'),
        },
      ],
    },
    {
      runId: 'r2',
      room: 'Lobby',
      device: 'Lobby screen',
      status: 'skipped',
      failedCount: 0,
      skipReason: 'Locked, key holder away',
      workedByName: null,
      results: [],
      photos: [],
    },
  ],
};

describe('export of maintenance visits', () => {
  it('writes one CSV row for each room, quoting what needs it', () => {
    const lines = visitsToCsv([visit]).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Room status');
    expect(lines[1]).toContain('Boardroom');
    expect(lines[1]).toContain('"Picture, clear"');
    expect(lines[1]).toContain('"Sam ""Tech"" <script>"');
    expect(lines[1]).toContain('Site: Head office');
    expect(lines[2]).toContain('Skipped');
    expect(lines[2]).toContain('"Locked, key holder away"');
  });

  it('a single-room visit is one row', () => {
    const one: ExportVisit = {
      ...visit,
      multi: false,
      scopeLabel: null,
      roomName: 'Boardroom',
      sections: [visit.sections[0]!],
    };
    expect(visitsToCsv([one]).split('\r\n')).toHaveLength(2);
  });

  it('prints every answer and escapes anything typed by a person', () => {
    const html = visitsToHtml([visit], { title: 'Maintenance <records>' });
    expect(html).toContain('Maintenance &lt;records&gt;');
    expect(html).toContain('Sam &quot;Tech&quot; &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Picture, clear');
    expect(html).toContain('Kestrel saw: All answering');
    expect(html).toContain('Skipped: Locked, key holder away');
  });

  it('groups the photos in a Media / files section at the foot of the visit', () => {
    const html = visitsToHtml([visit], { title: 'x' }, { p1: 'data:image/jpeg;base64,AAAA' });
    const media = html.indexOf('Media / files <span');
    expect(media).toBeGreaterThan(html.indexOf('Lobby'));
    expect(html).toContain('2 photos (see Media / files: 1, 2)');
    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA" alt="Photo 1">');
    expect(html).toContain('Picture not included');
    expect(html).toContain('SHA-256 abcdef0123456789');
  });

  it('counts photos in the CSV and leaves the Media section out when there are none', () => {
    expect(visitsToCsv([visit]).split('\r\n')[1]).toContain(',2,');
    const none = { ...visit, sections: visit.sections.map((s) => ({ ...s, photos: [] })) };
    expect(visitsToHtml([none], { title: 'x' })).not.toContain('Media / files <span');
  });

  it('says so when there is nothing to print', () => {
    expect(visitsToHtml([], { title: 'x' })).toContain('No visits.');
  });
});
