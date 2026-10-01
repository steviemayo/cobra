import type { ReactNode } from 'react';

/** A titled, bordered block with an optional action in its header. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
