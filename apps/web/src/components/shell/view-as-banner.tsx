'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Eye, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/trpc/client';

export interface ViewAs {
  sessionId: string;
  mode: 'read' | 'act';
  /** ISO time the session ends. */
  endsAt: string;
}

const left = (endsAt: string, now: number) =>
  Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 60_000));

/**
 * Shown for the whole time Kestrel staff are working inside a customer organisation, so nobody
 * mistakes it for a normal visit. Ending the session takes them back to the staff portal.
 */
export function ViewAsBanner({ session, email }: { session: ViewAs; email: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const minutes = left(session.endsAt, now);

  const end = useMutation(
    trpc.staff.session.end.mutationOptions({
      onSuccess: () => {
        router.push('/staff/orgs');
        router.refresh();
      },
    }),
  );

  // When the time runs out the next request is refused; send them back rather than show errors.
  useEffect(() => {
    if (minutes === 0) {
      router.push('/staff/orgs');
      router.refresh();
    }
  }, [minutes, router]);

  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 bg-warning px-3 py-1.5 text-sm text-black"
    >
      {session.mode === 'act' ? <Pencil className="size-4" /> : <Eye className="size-4" />}
      <span className="font-medium">
        Kestrel staff session ({email}):{' '}
        {session.mode === 'act' ? 'you can make changes' : 'view only'}
      </span>
      <span>{minutes} min left</span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-7"
        disabled={end.isPending}
        onClick={() => end.mutate({ sessionId: session.sessionId })}
      >
        End session
      </Button>
    </div>
  );
}
