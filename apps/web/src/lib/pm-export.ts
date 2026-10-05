import type { RouterOutputs } from '@/trpc/types';

export type ExportVisit = RouterOutputs['pm']['exportRuns'][number];

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const day = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString().slice(0, 10) : '';
const stamp = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');

const answerText = (r: string | number | null) =>
  r === 'pass' ? 'Pass' : r === 'fail' ? 'Fail' : r === 'na' ? 'N/A' : r === null ? '' : String(r);

const statusText = (s: string) =>
  s === 'signed' ? 'Signed off' : s === 'skipped' ? 'Skipped' : s === 'draft' ? 'Draft' : s;

/** Where a visit was: the site or area it covered, or its room or device. */
export const visitWhere = (v: ExportVisit) =>
  v.multi
    ? (v.scopeLabel ?? 'Several rooms')
    : [v.roomName, v.deviceName].filter(Boolean).join(' · ');

/** One row for each room of a visit (a single-room visit is one row), for a spreadsheet. */
export function visitsToCsv(visits: ExportVisit[]): string {
  const head = [
    'Visit',
    'Site',
    'Covers',
    'Checklist',
    'Room',
    'Device',
    'Room status',
    'Failed items',
    'Failed item names',
    'Skip reason',
    'Worked by',
    'Visit status',
    'Signed by',
    'Signed at',
    'Due',
    'Correction',
  ];
  const lines = [head.join(',')];
  for (const v of visits)
    for (const s of v.sections)
      lines.push(
        [
          v.id,
          v.siteName,
          v.multi ? v.scopeLabel : '',
          v.templateName,
          s.room,
          s.device,
          statusText(s.status),
          s.failedCount,
          s.results
            .filter((r) => r.result === 'fail')
            .map((r) => r.label)
            .join('; '),
          s.skipReason,
          s.workedByName,
          statusText(v.status),
          v.signedByName,
          stamp(v.signedAt),
          day(v.dueOn),
          v.correctsRunId ? 'Correction' : '',
        ]
          .map(csvCell)
          .join(','),
      );
  return lines.join('\r\n');
}

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A page that reads well printed: each visit, and under it each room with every answer. */
export function visitsToHtml(
  visits: ExportVisit[],
  opts: { title: string; subtitle?: string },
): string {
  const body = visits
    .map((v) => {
      const sections = v.sections
        .map((s) => {
          const heading = [s.room, s.device].filter(Boolean).join(' · ') || 'Visit';
          const status =
            s.status === 'skipped'
              ? `Skipped: ${esc(s.skipReason)}`
              : s.failedCount
                ? `${s.failedCount} failed`
                : s.status === 'signed'
                  ? 'Passed'
                  : 'Draft';
          const rows = s.results
            .map(
              (r) =>
                `<tr class="${r.result === 'fail' ? 'fail' : ''}"><td>${esc(r.label)}</td><td>${esc(answerText(r.result))}</td><td>${esc([r.note, r.kestrelSaw ? `Kestrel saw: ${r.kestrelSaw}` : ''].filter(Boolean).join(' · '))}</td></tr>`,
            )
            .join('');
          return `<section class="room"><h3>${v.multi ? `${esc(heading)} <span class="status">${status}</span>` : `<span class="status">${status}</span>`}</h3>${
            s.workedByName ? `<p class="meta">Worked on by ${esc(s.workedByName)}</p>` : ''
          }${
            rows
              ? `<table><thead><tr><th>Check</th><th>Result</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`
              : ''
          }</section>`;
        })
        .join('');
      return `<article class="visit"><h2>${esc(v.templateName)} — ${esc(visitWhere(v))}</h2><p class="meta">${
        v.siteName ? `${esc(v.siteName)} · ` : ''
      }${
        v.status === 'signed'
          ? `Signed off by ${esc(v.signedByName)} on ${esc(day(v.signedAt))}`
          : 'Draft, not signed off'
      }${v.dueOn ? ` · due ${esc(day(v.dueOn))}` : ''}${v.correctsRunId ? ' · correction of an earlier visit' : ''}</p>${
        v.notes ? `<p class="notes">${esc(v.notes)}</p>` : ''
      }${sections}</article>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.title)}</title><style>
    body{font:12px/1.4 system-ui,sans-serif;color:#111;margin:24px}
    h1{font-size:18px;margin:0 0 2px} h2{font-size:14px;margin:0 0 2px} h3{font-size:12px;margin:10px 0 4px}
    .meta,.sub{color:#555;margin:0 0 6px} .notes{margin:0 0 6px;white-space:pre-wrap}
    .visit{margin:0 0 22px;padding-top:12px;border-top:2px solid #111;break-inside:auto}
    .room{margin:0 0 10px;break-inside:avoid} .status{font-weight:400;color:#555;margin-left:6px}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}
    th{background:#f3f3f3} tr.fail td{background:#fdecec}
    @media print{body{margin:12mm}}
  </style></head><body><h1>${esc(opts.title)}</h1>${
    opts.subtitle ? `<p class="sub">${esc(opts.subtitle)}</p>` : ''
  }${body || '<p>No visits.</p>'}</body></html>`;
}

/** Opens the browser's print dialog for a page of HTML, where "Save as PDF" is one of the choices. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error('Could not open the print view');
  }
  doc.open();
  doc.write(html);
  doc.close();
  win.addEventListener('afterprint', () => frame.remove());
  // Give the page a moment to lay out, then print; remove the frame even if the dialog is cancelled quietly.
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 60_000);
  }, 150);
}
