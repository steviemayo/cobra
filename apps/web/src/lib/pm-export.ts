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

/** The most photos one PDF carries, so the page stays a size a browser can print. */
export const MAX_PDF_PHOTOS = 150;

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
    'Photos',
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
          s.photos.length,
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
  /** The pictures, by photo id, as data addresses. A photo with none is listed without its picture. */
  images: Record<string, string> = {},
): string {
  const body = visits
    .map((v) => {
      // Every photo of the visit, numbered, for the Media / files section at its foot.
      const media = v.sections.flatMap((s) =>
        s.photos.map((p) => ({ ...p, room: s.room, device: s.device })),
      );
      const numberOf = new Map(media.map((p, i) => [p.id, i + 1]));
      const mediaHtml = media.length
        ? `<section class="media"><h3>Media / files <span class="status">${media.length} photo${media.length === 1 ? '' : 's'}</span></h3><div class="grid">${media
            .map((p, i) => {
              const src = images[p.id];
              return `<figure>${
                src
                  ? `<img src="${esc(src)}" alt="Photo ${i + 1}">`
                  : '<div class="missing">Picture not included</div>'
              }<figcaption><strong>Photo ${i + 1}</strong> · ${esc(
                [p.room, p.device].filter(Boolean).join(' · '),
              )}<br>${esc(p.itemLabel)}<br><span class="hash">${esc(day(p.createdAt))} · ${esc(
                p.mime.replace('image/', '').toUpperCase(),
              )} · SHA-256 ${esc(p.sha256.slice(0, 16))}</span></figcaption></figure>`;
            })
            .join('')}</div></section>`
        : '';
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
            .map((r) => {
              const mine =
                r.type === 'photo'
                  ? s.photos.filter((p) => p.itemId === r.itemId).map((p) => numberOf.get(p.id))
                  : [];
              const shown =
                r.type === 'photo'
                  ? mine.length
                    ? `${mine.length} photo${mine.length === 1 ? '' : 's'} (see Media / files: ${mine.join(', ')})`
                    : 'No photos'
                  : answerText(r.result);
              return `<tr class="${r.result === 'fail' ? 'fail' : ''}"><td>${esc(r.label)}</td><td>${esc(shown)}</td><td>${esc([r.note, r.kestrelSaw ? `Kestrel saw: ${r.kestrelSaw}` : ''].filter(Boolean).join(' · '))}</td></tr>`;
            })
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
      }${sections}${mediaHtml}</article>`;
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
    .media{margin:14px 0 0;padding-top:8px;border-top:1px solid #999}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} figure{margin:0;break-inside:avoid}
    figure img{width:100%;max-height:220px;object-fit:contain;border:1px solid #ccc;background:#fafafa}
    figcaption{font-size:10px;margin-top:3px} .hash{color:#555;font-family:ui-monospace,monospace}
    .missing{border:1px dashed #999;padding:30px 6px;text-align:center;color:#777}
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
  // Wait for the pictures (and a moment to lay out), then print; remove the frame even if the dialog is cancelled quietly.
  const pictures = [...doc.images].map((img) =>
    img.complete
      ? Promise.resolve()
      : new Promise<void>((done) => {
          img.addEventListener('load', () => done());
          img.addEventListener('error', () => done());
        }),
  );
  void Promise.race([Promise.all(pictures), new Promise((done) => setTimeout(done, 15_000))]).then(
    () =>
      setTimeout(() => {
        win.focus();
        win.print();
        setTimeout(() => frame.remove(), 60_000);
      }, 150),
  );
}
