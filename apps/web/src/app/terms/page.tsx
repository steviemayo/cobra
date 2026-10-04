import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Terms of Service' };

// DRAFT outline (LR-1). Replace with the reviewed text, then change LEGAL_VERSION.terms in lib/legal.ts.
export default function TermsPage() {
  return (
    <LegalPage document="terms">
      <section>
        <h2>1. What Kestrel is</h2>
        <p>
          Kestrel is a service for monitoring, configuring and supporting audio-visual systems. An
          organisation signs up, connects a gateway on its own network, and its people use the web
          portal.
        </p>
      </section>
      <section>
        <h2>2. Your account and organisation</h2>
        <ul>
          <li>You must give accurate details and keep your sign-in secure.</li>
          <li>
            When you create an organisation you confirm you are allowed to accept these terms for
            it.
          </li>
          <li>Owners are responsible for who they invite and what role each person has.</li>
        </ul>
      </section>
      <section>
        <h2>3. Acceptable use</h2>
        <p>
          Do not use Kestrel to break the law, attack other systems, or probe networks you do not
          have permission to scan. Network discovery is for the networks of the organisation that
          installed the gateway.
        </p>
      </section>
      <section>
        <h2>4. Your data and room programs</h2>
        <p>
          You keep ownership of your data and of the room designs and configuration you create.
          Kestrel may use them only to run the service for you. See the Privacy Policy for how
          personal information is handled.
        </p>
      </section>
      <section>
        <h2>5. Plans, billing and cancelling</h2>
        <p>
          Plans are charged per monitored room. A provider may pay for an organisation if the
          organisation asks it to. You can cancel at any time; the plan runs to the end of the
          period you have paid for. [Refund terms to be confirmed.]
        </p>
      </section>
      <section>
        <h2>6. Availability</h2>
        <p>
          Kestrel is monitoring and support software, not a safety system. Rooms keep working if the
          service or the internet is unavailable. [Service level to be confirmed.]
        </p>
      </section>
      <section>
        <h2>7. Liability</h2>
        <p>
          [Limit of liability, including a configuration change that affects a room, to be
          confirmed.]
        </p>
      </section>
      <section>
        <h2>8. Changes</h2>
        <p>
          If these terms change in a way that matters, you will be asked to accept the new version
          before carrying on.
        </p>
      </section>
    </LegalPage>
  );
}
