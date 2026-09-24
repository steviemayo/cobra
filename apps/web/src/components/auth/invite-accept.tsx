'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { rememberOrg } from '@/lib/last-org';
import { createSupabaseBrowser } from '@/lib/supabase/client';
import { useTRPC } from '@/trpc/client';
import { AuthFormFrame } from './auth-form-frame';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  dev: 'Developer',
  support: 'Support',
  customer_viewer: 'Customer viewer',
};

export function InviteAccept({ token, userEmail }: { token: string; userEmail: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const preview = useQuery({ ...trpc.invite.preview.queryOptions({ token }), retry: false });
  const accept = useMutation(
    trpc.invite.accept.mutationOptions({
      onSuccess: ({ orgId }) => {
        rememberOrg(orgId);
        toast.success('You’ve joined the organisation');
        router.replace(`/o/${orgId}`);
        router.refresh();
      },
    }),
  );
  const next = `/invite/${token}`;

  if (preview.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-9 w-full" />
      </div>
    );

  if (preview.isError)
    return (
      <AuthFormFrame
        title="This invite isn’t valid"
        description="It may have expired, been used already, or been revoked. Ask the organisation owner for a new one."
      >
        <Link href="/" className={buttonVariants({ variant: 'outline' })}>
          Go to Kestrel
        </Link>
      </AuthFormFrame>
    );

  const { orgName, email, role } = preview.data;
  const title = `Join ${orgName}`;
  const description = (
    <>
      You’ve been invited as{' '}
      <span className="font-medium text-foreground">{ROLE_LABEL[role] ?? role}</span> using{' '}
      <span className="font-medium text-foreground">{email}</span>.
    </>
  );

  if (!userEmail)
    return (
      <AuthFormFrame title={title} description={description}>
        <div className="flex flex-col gap-2">
          <Link
            href={`/signup?next=${encodeURIComponent(next)}`}
            className={buttonVariants({ size: 'lg' })}
          >
            Create an account
          </Link>
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            I already have an account
          </Link>
        </div>
      </AuthFormFrame>
    );

  if (userEmail !== email)
    return (
      <AuthFormFrame title={title} description={description}>
        <p className="text-sm text-muted-foreground">
          You’re signed in as <span className="font-medium text-foreground">{userEmail}</span>, but
          this invite is for {email}. Sign out and continue with the invited address.
        </p>
        <Button
          variant="outline"
          onClick={async () => {
            await createSupabaseBrowser().auth.signOut();
            router.replace(`/login?next=${encodeURIComponent(next)}`);
            router.refresh();
          }}
        >
          Sign out
        </Button>
      </AuthFormFrame>
    );

  return (
    <AuthFormFrame title={title} description={description}>
      {accept.error && <p className="text-sm text-destructive">{accept.error.message}</p>}
      <Button
        size="lg"
        className="w-full"
        disabled={accept.isPending}
        onClick={() => accept.mutate({ token })}
      >
        {accept.isPending && <Spinner />}
        Accept invitation
      </Button>
    </AuthFormFrame>
  );
}
