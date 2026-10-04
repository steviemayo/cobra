'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';

/** Asks someone to accept the current Terms and Privacy Policy before carrying on. */
export function AcceptTerms() {
  const trpc = useTRPC();
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const accept = useMutation(
    trpc.legal.accept.mutationOptions({
      onSuccess: () => {
        router.replace('/');
        router.refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="mx-auto max-w-sm space-y-5 px-4 py-16">
      <div>
        <h1 className="text-xl font-semibold">Our terms have changed</h1>
        <p className="text-sm text-muted-foreground">
          Please read the current Terms of Service and Privacy Policy, then agree to carry on.
        </p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          <Link href="/terms" target="_blank" className="underline underline-offset-2">
            Terms of Service
          </Link>
        </li>
        <li>
          <Link href="/privacy" target="_blank" className="underline underline-offset-2">
            Privacy Policy
          </Link>
        </li>
      </ul>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        I have read them and agree.
      </label>
      <Button disabled={!agreed || accept.isPending} onClick={() => accept.mutate()}>
        {accept.isPending && <Spinner />}
        Continue
      </Button>
    </div>
  );
}
