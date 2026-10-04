import Link from 'next/link';
import { LEGAL_PATH, LEGAL_TITLE, LEGAL_VERSION, type LegalDocument } from '@/lib/legal';

/** A public page for one legal document, with the "draft" notice shown until a lawyer has reviewed it. */
export function LegalPage({
  document,
  children,
}: {
  document: LegalDocument;
  children: React.ReactNode;
}) {
  const other: LegalDocument = document === 'terms' ? 'privacy' : 'terms';
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      <div className="space-y-1">
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          Kestrel
        </Link>
        <h1 className="text-2xl font-semibold">{LEGAL_TITLE[document]}</h1>
        <p className="text-sm text-muted-foreground">Version {LEGAL_VERSION[document]}</p>
      </div>
      <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
        <strong>Draft.</strong> This is an outline of how Kestrel intends to work, written before a
        lawyer has reviewed it. It is not final and may change. If you have a question, ask your
        Kestrel contact.
      </p>
      <div className="space-y-6 text-sm leading-relaxed [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
      <p className="border-t pt-4 text-sm text-muted-foreground">
        See also the{' '}
        <Link href={LEGAL_PATH[other]} className="underline underline-offset-2">
          {LEGAL_TITLE[other]}
        </Link>
        .
      </p>
    </main>
  );
}
