import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/legal-page';
import { SUBPROCESSORS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Privacy Policy' };

// DRAFT outline (LR-2, LR-4). Replace with the reviewed text, then change LEGAL_VERSION.privacy in lib/legal.ts.
export default function PrivacyPage() {
  return (
    <LegalPage document="privacy">
      <section>
        <h2>1. What we hold</h2>
        <ul>
          <li>Account details: your name, work email and sign-in activity.</li>
          <li>
            Organisation data: rooms, devices, settings, incidents, tickets, audit entries and the
            files you attach.
          </li>
          <li>
            Network details about your devices: addresses, names, serial numbers and how they have
            been answering.
          </li>
          <li>Billing details are held by our payment provider, not by Kestrel.</li>
        </ul>
      </section>
      <section>
        <h2>2. Why</h2>
        <p>
          To run the service you asked for, keep it secure, support you, and bill you. We do not
          sell personal information.
        </p>
      </section>
      <section>
        <h2>3. How long</h2>
        <p>
          Monitoring history and audit entries are kept for the periods set in your organisation (90
          days by default). An organisation scheduled for deletion is removed 30 days later. [Full
          retention schedule to be confirmed.]
        </p>
      </section>
      <section>
        <h2>4. Who else handles it</h2>
        <p>These companies process data for us:</p>
        <ul>
          {SUBPROCESSORS.map((s) => (
            <li key={s.name}>
              <strong>{s.name}</strong>: {s.does} ({s.where})
            </li>
          ))}
        </ul>
        <p>
          Kestrel staff can open a support session in your organisation. You are shown when one
          starts, why, and every change made, and you can require a support ticket first.
        </p>
      </section>
      <section>
        <h2>5. Where</h2>
        <p>
          The database is in Sydney, Australia. [Where the web portal and email are processed to be
          confirmed.]
        </p>
      </section>
      <section>
        <h2>6. Your rights</h2>
        <p>
          You can ask to see, correct or delete personal information we hold about you, and an owner
          can delete an organisation. [A full data export is planned.] [Contact and complaints
          details to be confirmed.]
        </p>
      </section>
    </LegalPage>
  );
}
