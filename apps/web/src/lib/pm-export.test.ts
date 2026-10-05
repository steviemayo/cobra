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
      room: 'Boardroom',
      device: null,
      status: 'signed',
      failedCount: 1,
      skipReason: null,
      workedByName: 'Sam',
      results: [
        { label: 'Picture, clear', result: 'fail', note: 'Flickers', kestrelSaw: null },
        { label: 'Audio', result: 'pass', note: null, kestrelSaw: 'All answering' },
      ],
    },
    {
      room: 'Lobby',
      device: 'Lobby screen',
      status: 'skipped',
      failedCount: 0,
      skipReason: 'Locked, key holder away',
      workedByName: null,
      results: [],
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

  it('says so when there is nothing to print', () => {
    expect(visitsToHtml([], { title: 'x' })).toContain('No visits.');
  });
});
