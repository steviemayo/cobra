// The look of the gateway's own page. It follows the Kestrel web app: the same colours, 0.5rem corners,
// IBM Plex when the machine has it (the system font otherwise: nothing is downloaded, the page works with
// no internet) and light or dark to match the browser. Each colour is given as a plain hex first and then
// as oklch(), so a browser that does not know oklch still gets the right colours.

export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const CSS = `
:root{color-scheme:light dark;
--background:#fbfbfc;--background:oklch(0.99 0.002 250);
--foreground:#1b1f27;--foreground:oklch(0.2 0.02 255);
--card:#fff;--card:oklch(1 0 0);
--muted:#f1f2f5;--muted:oklch(0.96 0.006 250);
--muted-foreground:#6a7180;--muted-foreground:oklch(0.5 0.02 255);
--border:#e2e4e9;--border:oklch(0.91 0.008 250);
--primary:#1d2331;--primary:oklch(0.22 0.025 255);
--primary-foreground:#fafbfc;--primary-foreground:oklch(0.985 0.002 250);
--brand:#12849a;--brand:oklch(0.55 0.11 200);
--success:#1e9a5f;--success:oklch(0.6 0.14 155);
--warning:#d49a14;--warning:oklch(0.75 0.15 75);
--destructive:#cf3a2b;--destructive:oklch(0.55 0.21 27);
--radius:0.5rem}
@media (prefers-color-scheme:dark){:root{
--background:#12151b;--background:oklch(0.165 0.012 255);
--foreground:#f1f2f4;--foreground:oklch(0.96 0.005 250);
--card:#1a1e26;--card:oklch(0.2 0.014 255);
--muted:#222731;--muted:oklch(0.25 0.015 255);
--muted-foreground:#a3a8b2;--muted-foreground:oklch(0.7 0.015 250);
--border:#2a2e37;--border:oklch(1 0 0 / 9%);
--primary:#eceef1;--primary:oklch(0.94 0.008 250);
--primary-foreground:#171a21;--primary-foreground:oklch(0.2 0.02 255);
--brand:#3fb4cb;--brand:oklch(0.7 0.11 200);
--success:#4ccb89;--success:oklch(0.72 0.15 155);
--warning:#e6b13e;--warning:oklch(0.8 0.14 78);
--destructive:#ee6a5b;--destructive:oklch(0.7 0.18 22)}}
*{box-sizing:border-box}
body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.55 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-underline-offset:2px}
code,.mono{font:12.5px "IBM Plex Mono",ui-monospace,SFMono-Regular,Consolas,monospace}
code{word-break:break-all}
header.top{border-bottom:1px solid var(--border);background:var(--card)}
.bar{max-width:1040px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mark{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;background:var(--brand);color:#fff;font-weight:600;font-size:14px}
.brand{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px;color:var(--foreground);text-decoration:none}
.spacer{flex:1}
nav.tabs{max-width:1040px;margin:0 auto;padding:0 8px;display:flex;gap:2px;overflow-x:auto}
nav.tabs a{padding:9px 12px;color:var(--muted-foreground);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}
nav.tabs a:hover{color:var(--foreground)}
nav.tabs a.on{color:var(--foreground);border-bottom-color:var(--brand);font-weight:500}
main{max-width:1040px;margin:0 auto;padding:20px 16px 56px}
h1{font-size:20px;font-weight:600;margin:0 0 4px;letter-spacing:-0.01em}
h2{font-size:14px;font-weight:600;margin:0 0 10px}
.sub{color:var(--muted-foreground);margin:0 0 16px}
.muted{color:var(--muted-foreground)}
.card,section.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin:0 0 14px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid>.card{margin:0}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}
dl.kv dt{color:var(--muted-foreground)}dl.kv dd{margin:0;word-break:break-word}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--border);vertical-align:top}
th{color:var(--muted-foreground);font-weight:500;font-size:12px;border-top:0;white-space:nowrap}
.tablewrap{overflow-x:auto}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid var(--border);background:var(--muted);white-space:nowrap}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--muted-foreground)}
.pill.ok::before{background:var(--success)}.pill.warn::before{background:var(--warning)}.pill.fail::before{background:var(--destructive)}.pill.info::before{background:var(--brand)}
.ok{color:var(--success)}.bad{color:var(--destructive)}.warnc{color:var(--warning)}
.banner{padding:10px 14px;border-radius:var(--radius);border:1px solid var(--border);margin:0 0 14px;background:var(--card)}
.banner.ok{border-color:var(--success)}.banner.bad{border-color:var(--destructive)}.banner.warn{border-color:var(--warning)}
.hint{border-left:3px solid var(--brand);padding:8px 12px;margin:10px 0 0;background:var(--muted);border-radius:0 var(--radius) var(--radius) 0}
label{display:block;margin:10px 0 4px;font-weight:500}
input[type=text],input[type=password]{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--background);color:var(--foreground);font:inherit}
input:focus-visible,button:focus-visible,a:focus-visible,select:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;padding:7px 14px;border:1px solid var(--primary);border-radius:var(--radius);background:var(--primary);color:var(--primary-foreground);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}
button.outline,.btn.outline{background:transparent;color:var(--foreground);border-color:var(--border)}
button.danger{background:var(--destructive);border-color:var(--destructive);color:#fff}
button.plain{background:transparent;color:var(--foreground);border-color:transparent;margin:0;padding:4px 8px}
form.inline{display:inline}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.filters a{padding:3px 11px;border:1px solid var(--border);border-radius:999px;color:var(--foreground);text-decoration:none;font-size:13px}
.filters a.on{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
details summary{cursor:pointer;color:var(--muted-foreground)}
td.time{white-space:nowrap;color:var(--muted-foreground)}
.empty{padding:22px 8px;text-align:center;color:var(--muted-foreground)}
footer{max-width:1040px;margin:0 auto;padding:0 16px 28px;color:var(--muted-foreground);font-size:12px}
@media (max-width:600px){.bar{padding:8px 12px}main{padding:14px 12px 40px}dl.kv{grid-template-columns:1fr;gap:0}dl.kv dt{margin-top:8px}}
`;

export interface Tab {
  href: string;
  label: string;
}

export interface LayoutOptions {
  title: string;
  body: string;
  /** Shown in the header: who is signed in and the buttons for it. */
  who?: { name: string; role: string } | null;
  gatewayName?: string | null;
  status?: { text: string; kind: 'ok' | 'warn' | 'fail' } | null;
  tabs?: Tab[];
  active?: string;
  /** Re-read the page every 30 seconds. */
  refresh?: boolean;
  version?: string;
}

export function layout(o: LayoutOptions): string {
  const nav = o.tabs?.length
    ? `<nav class="tabs" aria-label="Gateway">${o.tabs
        .map(
          (t) =>
            `<a href="${esc(t.href)}"${t.href === o.active ? ' class="on" aria-current="page"' : ''}>${esc(t.label)}</a>`,
        )
        .join('')}</nav>`
    : '';
  const right = [
    o.status ? pill(o.status.kind, o.status.text) : '',
    o.who
      ? `<span class="muted">${esc(o.who.name)} · ${esc(o.who.role)}</span><form class="inline" method="post" action="/signout"><button class="plain" type="submit">Sign out</button></form>`
      : '',
  ].join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${o.refresh ? '<meta http-equiv="refresh" content="30">' : ''}<title>${esc(o.title)} · Kestrel gateway</title><style>${CSS}</style></head><body>
<header class="top"><div class="bar"><a class="brand" href="/"><span class="mark" aria-hidden="true">K</span>Kestrel gateway${o.gatewayName ? `<span class="muted" style="font-weight:400">· ${esc(o.gatewayName)}</span>` : ''}</a><span class="spacer"></span>${right}</div>${nav}</header>
<main>${o.body}</main>${o.version ? `<footer>Version ${esc(o.version)}</footer>` : ''}</body></html>`;
}

export const pill = (kind: 'ok' | 'warn' | 'fail' | 'info', text: string): string =>
  `<span class="pill ${kind}">${esc(text)}</span>`;

export function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function duration(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

export function kv(rows: [string, string][]): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

export function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="tablewrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}
