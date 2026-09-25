/** Hands a file the server built to the browser as a download. */
export function downloadFile(file: { filename: string; contentType: string; body: string }) {
  // A byte order mark makes Excel read a CSV as UTF-8, so names with accents survive.
  const bom = file.contentType.startsWith('text/csv') ? '﻿' : '';
  const url = URL.createObjectURL(
    new Blob([bom + file.body], { type: `${file.contentType};charset=utf-8` }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
