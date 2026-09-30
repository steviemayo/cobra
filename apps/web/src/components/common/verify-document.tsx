'use client';
import { useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type Verdict =
  | {
      valid: true;
      org: string | null;
      number: number | null;
      title: string | null;
      takenAt: string | null;
      kind: string | null;
    }
  | { valid: false; reason: string };

const REASON: Record<string, string> = {
  malformed: 'That is not a Kestrel document.',
  wrong_purpose: 'That document is not of a kind that can be checked here.',
  hash_mismatch: 'The content has been changed since it was signed.',
  unknown_key: 'It was signed with a key Kestrel does not recognise.',
  bad_signature: 'The signature does not match the content.',
};

/** Paste or choose a signed register or report (JSON) and check it against the keys Kestrel signs with. */
export function VerifyDocument() {
  const [text, setText] = useState('');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(body: string) {
    setBusy(true);
    setVerdict(null);
    try {
      const res = await fetch('/api/verify', { method: 'POST', body });
      setVerdict((await res.json()) as Verdict);
    } catch {
      setVerdict({ valid: false, reason: 'malformed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="Paste the signed JSON here, or choose the file below"
        className="font-mono text-xs"
        aria-label="Signed document"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Choose a signed document"
          className="text-sm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const t = await f.text();
            setText(t.length > 200_000 ? '' : t);
            void check(t);
          }}
        />
        <Button size="sm" disabled={!text.trim() || busy} onClick={() => void check(text)}>
          Check it
        </Button>
      </div>
      {verdict &&
        (verdict.valid ? (
          <div className="flex items-start gap-3 rounded-lg border border-success/40 bg-success/5 p-4 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <div>
              <div className="font-medium">Genuine. Kestrel signed this exact content.</div>
              <div className="text-muted-foreground">
                {verdict.title ?? 'Signed document'}
                {verdict.org ? ` for ${verdict.org}` : ''}
                {verdict.takenAt
                  ? `, issued ${new Date(verdict.takenAt).toLocaleString('en-AU')}`
                  : ''}
                . The signature shows Kestrel issued it and that it is unchanged. Values people
                typed in are their own word: each row says which were read from the device.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <div className="font-medium">Not valid.</div>
              <div className="text-muted-foreground">
                {REASON[verdict.reason] ?? 'It could not be checked.'}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}
