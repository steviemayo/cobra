import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A QR code as an inline SVG, so it needs no image request and stays sharp at any size. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { size: n, path: d };
  }, [value]);
  const quiet = 4;
  const box = size + quiet * 2;
  return (
    <svg
      className="kp-qr"
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
