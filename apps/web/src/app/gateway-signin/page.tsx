import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { Button } from '@/components/ui/button';
import { createSupabaseServer } from '@/lib/supabase/server';
import { checkSignin } from '@/server/gateway-signin';

export const metadata: Metadata = { title: 'Sign in to a gateway' };

const PROBLEMS: Record<string, string> = {
  bad_request: 'This sign-in link is not valid. Go back to the gateway and choose “Sign in with Kestrel” again.',
  unknown_gateway: 'That gateway is not known to Kestrel.',
  not_a_member:
    'Your account does not belong to the organisation this gateway is in, so it cannot sign you in. Sign in to Kestrel with the right account and try again.',
  bad_return:
    'This gateway has not told Kestrel it can be reached at that address yet, so you cannot be sent back to it. Open the gateway page using its usual address, and make sure the gateway is online and up to date.',
};

// Where the gateway's own page sends someone who chose "Sign in with Kestrel". Nothing is decided
// from the link: the gateway is looked up, the person must belong to its organisation, and they can
// only be sent back to an address that gateway has reported. Approving posts to /gateway-signin/approve.
export default async function GatewaySigninPage({
  searchParams,
}: {
  searchParams: Promise<{ gateway?: string; state?: string; return?: string }>;
}) {
  const q = await searchParams;
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) redirect('/login');

  // Two-step sign-in applies here as it does in the portal.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    const here = `/gateway-signin?${new URLSearchParams(
      Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ).toString()}`;
    redirect(`/auth/mfa?next=${encodeURIComponent(here)}`);
  }

  const check = await checkSignin(db, user.id, {
    gatewayId: q.gateway ?? '',
    state: q.state ?? '',
    returnOrigin: q.return ?? '',
  });

  if (!check.ok) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-16">
        <h1 className="text-xl font-semibold">Can’t sign you in to the gateway</h1>
        <p className="text-sm text-muted-foreground">{PROBLEMS[check.reason]}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-5 px-4 py-16">
      <div>
        <h1 className="text-xl font-semibold">Sign in to {check.gateway.name}</h1>
        <p className="text-sm text-muted-foreground">
          {check.gateway.orgName} · {check.gateway.siteName}
        </p>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border p-4 text-sm">
        <dt className="text-muted-foreground">Signing in as</dt>
        <dd>{user.email}</dd>
        <dt className="text-muted-foreground">Access</dt>
        <dd>
          {check.role === 'admin'
            ? 'Can change this gateway’s settings'
            : 'Can look at this gateway, not change it'}
        </dd>
        <dt className="text-muted-foreground">Sent back to</dt>
        <dd className="break-all">{check.returnOrigin}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        Only continue if you opened this from the gateway’s own page. The gateway will keep you
        signed in for up to 8 hours, and this sign-in is recorded in your organisation’s audit
        trail.
      </p>
      <form method="post" action="/gateway-signin/approve" className="flex gap-3">
        <input type="hidden" name="gateway" value={check.gateway.id} />
        <input type="hidden" name="state" value={q.state} />
        <input type="hidden" name="return" value={check.returnOrigin} />
        <Button type="submit">Sign in to the gateway</Button>
        <a
          href="/"
          className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
        >
          Cancel
        </a>
      </form>
    </div>
  );
}
