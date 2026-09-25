'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { createSupabaseBrowser } from '@/lib/supabase/client';

interface Enrolment {
  factorId: string;
  qr: string;
  secret: string;
}

/**
 * Staff need an authenticator app code every session. First time: scan a QR code to enrol. After
 * that: type the current code.
 */
export function StaffMfa() {
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowser());
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError(listError.message);
        setReady(true);
        return;
      }
      const verified = data.totp[0];
      if (verified) {
        setFactorId(verified.id);
        setReady(true);
        return;
      }
      // Clear half-finished enrolments so the new QR code is the only one that works.
      for (const f of data.all.filter((x) => x.factor_type === 'totp'))
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data: made, error: enrolError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Kestrel staff',
      });
      if (cancelled) return;
      if (enrolError || !made) setError(enrolError?.message ?? 'Could not start enrolment');
      else {
        setFactorId(made.id);
        setEnrolment({ factorId: made.id, qr: made.totp.qr_code, secret: made.totp.secret });
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) {
      setError(challenge.error.message);
      setBusy(false);
      return;
    }
    const res = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: code.trim(),
    });
    if (res.error) {
      setError('That code was not right. Check the time on your phone and try again.');
      setBusy(false);
      return;
    }
    router.replace('/staff/orgs');
    router.refresh();
  };

  return (
    <div className="mx-auto max-w-sm space-y-5 px-4 py-16">
      <div>
        <h1 className="text-xl font-semibold">Staff sign-in</h1>
        <p className="text-sm text-muted-foreground">
          {enrolment
            ? 'Scan this with an authenticator app, then enter the 6-digit code it shows.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </div>
      {!ready && <Spinner />}
      {enrolment && (
        <div className="space-y-2">
          {/* The QR code is a data URI made by Supabase. */}
          <img
            src={enrolment.qr}
            alt="Authenticator app QR code"
            className="size-48 rounded bg-white p-2"
          />
          <p className="text-xs text-muted-foreground">
            Or enter this key by hand: <code className="break-all">{enrolment.secret}</code>
          </p>
        </div>
      )}
      {ready && factorId && (
        <form onSubmit={verify} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="mfa-code">Code</Label>
            <Input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy && <Spinner />} Continue
          </Button>
        </form>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
