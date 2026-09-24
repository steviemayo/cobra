import type { SVGProps } from 'react';

function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    />
  );
}

const paths: Record<string, React.ReactNode> = {
  present: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  'video-call': (
    <>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="m15 11 6-3v8l-6-3" />
    </>
  ),
  record: <circle cx="12" cy="12" r="6" />,
  power: <path d="M12 3v9M6.3 6.6a8 8 0 1 0 11.4 0" />,
  custom: <path d="M5 12h14M12 5v14" />,
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  warning: <path d="M12 4 3 20h18zM12 10v4M12 17.5v.01" />,
  info: <path d="M12 8v.01M12 12v5M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" />,
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  volume: <path d="M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6" />,
  mute: <path d="M4 10v4h4l5 4V6L8 10zM16 9l5 6M21 9l-5 6" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  return <Svg {...rest}>{paths[name] ?? paths.custom}</Svg>;
}
