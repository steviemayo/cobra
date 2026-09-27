'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { createSupabaseBrowser } from '@/lib/supabase/client';
import { ssoDomain, ssoErrorMessage, ssoRedirect } from '@/lib/sso';
import { AuthFormFrame, FormError } from './auth-form-frame';
import { PasswordInput } from './password-input';

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(notice ?? null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState(false);
  const q = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;

  // Single sign-on: the company's identity provider signs the person in, found from their email's domain.
  async function signInWithSso(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const domain = ssoDomain(email);
    if (!domain) {
      setError('Enter your work email address.');
      return;
    }
    setBusy(true);
    const { data, error } = await createSupabaseBrowser().auth.signInWithSSO({
      domain,
      options: { redirectTo: ssoRedirect(window.location.origin, next) },
    });
    if (error || !data?.url) {
      setBusy(false);
      setError(ssoErrorMessage(error?.message));
      return;
    }
    window.location.assign(data.url);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } = await createSupabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      setBusy(false);
      setError(
        /invalid login/i.test(error.message)
          ? 'Email or password is incorrect.'
          : /not confirmed/i.test(error.message)
            ? 'Confirm your email first. Check your inbox for the link.'
            : error.message,
      );
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <AuthFormFrame title="Sign in" description="Welcome back. Sign in to manage your rooms.">
      {sso ? (
        <form onSubmit={signInWithSso} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sso-email">Work email</Label>
            <Input
              id="sso-email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              We’ll send you to your company’s sign-in page.
            </p>
          </div>
          <FormError message={error} />
          <Button type="submit" className="w-full" size="lg" disabled={busy}>
            {busy && <Spinner />}
            Continue with single sign-on
          </Button>
          <button
            type="button"
            onClick={() => {
              setSso(false);
              setError(null);
            }}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Sign in with a password instead
          </button>
        </form>
      ) : (
        <>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Forgot password?
                </Link>
              </div>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <FormError message={error} />
            <Button type="submit" className="w-full" size="lg" disabled={busy}>
              {busy && <Spinner />}
              Sign in
            </Button>
          </form>
          <button
            type="button"
            onClick={() => {
              setSso(true);
              setError(null);
            }}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Sign in with single sign-on
          </button>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        New to Kestrel?{' '}
        <Link
          href={`/signup${q}`}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </AuthFormFrame>
  );
}
