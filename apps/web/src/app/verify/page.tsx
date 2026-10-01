import type { Metadata } from 'next';
import { VerifyDocument } from '@/components/common/verify-document';

export const metadata: Metadata = { title: 'Check a signed document' };

// Public: anyone holding a signed Kestrel asset register or maintenance report can check it here.
export default function VerifyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Check a signed document</h1>
      <p className="text-sm text-muted-foreground">
        Paste or choose the signed JSON of an asset register or maintenance report issued by Kestrel.
        Nothing is stored. The check shows whether Kestrel signed exactly this content.
      </p>
      <VerifyDocument />
    </main>
  );
}
