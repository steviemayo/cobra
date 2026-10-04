'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { PROVIDER_NEXT } from '@/lib/auth-redirect';
import { signupAcceptanceMetadata } from '@/lib/legal';
import { createSupabaseBrowser } from '@/lib/supabase/client';
import { AuthFormFrame, FormError } from './auth-form-frame';
import { PasswordInput } from './password-input';

export function SignupForm({ next, provider }: { next: string; provider: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // The provider link's own destination is not something to carry to sign-in, or to treat as an invite.
  const plain = next === '/' || next === PROVIDER_NEXT;
  const q = plain ? '' : `?next=${encodeURIComponent(next)}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Passwords do not match.');
    if (!agreed) return setError('Please agree to the Terms and Privacy Policy to continue.');
    setBusy(true);
    const { data, error } = await createSupabaseBrowser().auth.signUp({
      email,
      password,
      options: {
        // Kept on the account, because there is no session yet to record the acceptance with.
        data: signupAcceptanceMetadata(),
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    setBusy(false);
    if (error) return setError(error.message);
    if (data.session) {
      router.replace(next);
      router.refresh();
    } else setSent(true);
  }

  if (sent)
    return (
      <AuthFormFrame
        title="Check your email"
        description={
          <>
            We sent a confirmation link to{' '}
            <span className="font-medium text-foreground">{email}</span>. Open it to finish creating
            your account.
          </>
        }
      >
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          <MailCheck className="size-5 shrink-0 text-brand" />
          Didn’t get it? Check spam, or try again in a minute.
        </div>
        <Button variant="outline" onClick={() => setSent(false)}>
          Use a different email
        </Button>
      </AuthFormFrame>
    );

  return (
    <AuthFormFrame
      title="Create your account"
      description={
        provider
          ? 'Look after your customers’ AV systems from one place.'
          : 'Start modelling rooms in minutes.'
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
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
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span>
            I agree to the{' '}
            <Link href="/terms" target="_blank" className="underline underline-offset-2">
              Terms of Service
            </Link>{' '}
            and the{' '}
            <Link href="/privacy" target="_blank" className="underline underline-offset-2">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        <FormError message={error} />
        <Button type="submit" className="w-full" size="lg" disabled={busy}>
          {busy && <Spinner />}
          Create account
        </Button>
      </form>
      {plain && (
        <p className="text-sm text-muted-foreground">
          {provider ? 'Managing rooms for your own organisation? ' : 'Are you a service provider? '}
          <Link
            href={provider ? '/signup' : '/signup?as=provider'}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {provider ? 'Sign up here' : 'Sign up as one'}
          </Link>
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href={`/login${q}`}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </AuthFormFrame>
  );
}
