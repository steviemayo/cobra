import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  ClipboardCheck,
  FileCheck2,
  LifeBuoy,
  LineChart,
  ServerCog,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Why Kestrel',
  description:
    'Monitoring, configuration, support and analytics for every audio-visual room, whatever the vendor.',
};

const pillars = [
  {
    icon: Activity,
    title: 'Monitor',
    text: 'Live status for every room and device. When a gateway goes offline you get one incident, not forty.',
  },
  {
    icon: ServerCog,
    title: 'Configure',
    text: 'Profiles, snapshots and drift detection. Put a changed setting back automatically, and keep a record of every correction.',
  },
  {
    icon: LifeBuoy,
    title: 'Support',
    text: 'Incident to ticket to your service desk or provider, with SLA targets, maintenance windows and clear ownership.',
  },
  {
    icon: LineChart,
    title: 'Analyse',
    text: 'See which rooms are used, which are empty, and which stay on after hours. Built from the devices already in the room.',
  },
];

const alsoBuiltIn = [
  {
    icon: ClipboardCheck,
    title: 'Asset register',
    text: 'One register for active and passive equipment. Each field shows whether it was discovered or typed in.',
  },
  {
    icon: FileCheck2,
    title: 'Signed register issues',
    text: 'Numbered, signed copies of your register you can hand to an auditor, with a page that verifies them.',
  },
  {
    icon: Wrench,
    title: 'Preventative maintenance',
    text: 'Scheduled visits with photo evidence and signed corrections.',
  },
];

const steps = [
  [
    'Install the gateway',
    'Run it on a Windows PC or in Docker on the network that holds your devices.',
  ],
  ['Claim it in the portal', 'It announces itself. You assign it to a site and it enrols itself.'],
  ['Watch your rooms', 'Devices appear with live status, history and alerts.'],
];

const comparison = [
  ['Works across vendors', 'Yes', 'Mostly one vendor', 'Yes'],
  ['Self-serve, start in an afternoon', 'Yes', 'Yes', 'No, sales-led'],
  ['Config enforcement and drift', 'Yes', 'Varies', 'Varies'],
  ['Incident to ticket to provider', 'Yes', 'Basic', 'Yes'],
  ['Built for service providers', 'Yes', 'Limited', 'Limited'],
  ['Priced per room', 'Yes', 'Per device', 'Quote'],
];

const soon = [
  'Microsoft Teams Rooms and Zoom Rooms health, with no gateway needed',
  'Pull rooms and devices in from other management portals',
  'Scheduled actions, such as powering off every display at a set time',
  'A wider public API with scoped tokens',
];

const security = [
  'Outbound-only gateway. No inbound ports are opened on your network.',
  'Configuration bundles are signed and checked on every deploy.',
  'Every change is in the audit log. Every query is scoped to your organisation.',
  'Data is stored in Australia.',
];

export default function WhyKestrelPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Link href="/why-kestrel" aria-label="Kestrel">
          <Logo />
        </Link>
        <nav className="flex items-center gap-2">
          <Link href="/login" className={buttonVariants({ variant: 'ghost' })}>
            Sign in
          </Link>
          <Link href="/signup" className={buttonVariants()}>
            Start free trial
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-5xl space-y-6 px-4 py-16 sm:py-24">
          <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            AV monitoring, configuration and support
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Every room. Every device. Know before they do.
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Kestrel watches your audio-visual estate, holds it to a standard, helps you fix it and
            shows how it is used. It works across vendors, and you can start without a sales call.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/signup" className={buttonVariants({ size: 'lg' })}>
              Start free trial
            </Link>
            <Link href="/login" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
              Sign in
            </Link>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 pt-2 text-sm text-muted-foreground">
            <li>Any vendor</li>
            <li>5 rooms free for 30 days</li>
            <li>Data stored in Australia</li>
            <li>No inbound ports</li>
          </ul>
        </section>

        <section className="border-y bg-muted/40">
          <div className="mx-auto grid max-w-5xl gap-6 px-4 py-12 sm:grid-cols-3">
            {[
              [
                'Found out from a user',
                'The first you hear about a dead room is the meeting that needed it.',
              ],
              [
                'Rooms drift from standard',
                'Someone changes an input setting and nobody notices until it matters.',
              ],
              [
                'Nobody knows what is used',
                'You pay to maintain rooms you cannot show anyone uses.',
              ],
            ].map(([t, d]) => (
              <div key={t} className="space-y-1">
                <h2 className="font-semibold">{t}</h2>
                <p className="text-sm text-muted-foreground">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-5xl space-y-8 px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Four jobs, one place</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {pillars.map(({ icon: Icon, title, text }) => (
              <div key={title} className="space-y-2 rounded-lg border bg-card p-5">
                <Icon className="size-5 text-brand" aria-hidden />
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-5xl space-y-8 px-4 pb-16">
          <h2 className="text-2xl font-semibold tracking-tight">Also built in</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {alsoBuiltIn.map(({ icon: Icon, title, text }) => (
              <div key={title} className="space-y-2">
                <Icon className="size-5 text-brand" aria-hidden />
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-y bg-muted/40">
          <div className="mx-auto max-w-5xl space-y-8 px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">Up and running in three steps</h2>
            <ol className="grid gap-6 sm:grid-cols-3">
              {steps.map(([t, d], i) => (
                <li key={t} className="space-y-1">
                  <span className="font-mono text-sm text-muted-foreground">0{i + 1}</span>
                  <h3 className="font-semibold">{t}</h3>
                  <p className="text-sm text-muted-foreground">{d}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-5xl space-y-6 px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Where Kestrel fits</h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className="p-3 font-medium" />
                  <th className="p-3 font-semibold">Kestrel</th>
                  <th className="p-3 font-medium text-muted-foreground">A single-vendor tool</th>
                  <th className="p-3 font-medium text-muted-foreground">An enterprise platform</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(([row, ...cells]) => (
                  <tr key={row} className="border-t">
                    <th scope="row" className="p-3 font-normal">
                      {row}
                    </th>
                    {cells.map((c, i) => (
                      <td
                        key={i}
                        className={cn('p-3', i === 0 ? 'font-medium' : 'text-muted-foreground')}
                      >
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            A general view of the market by category, not a claim about any one product.
          </p>
        </section>

        <section className="mx-auto max-w-5xl space-y-4 px-4 pb-16">
          <h2 className="text-2xl font-semibold tracking-tight">For service providers</h2>
          <p className="max-w-2xl text-muted-foreground">
            Run your own estate and every customer from one account. See a portfolio view of rooms,
            incidents and SLAs at risk, work inside a customer when you need to, and put your own
            brand on what they see. Each customer keeps its own data and pays for its own rooms.
          </p>
        </section>

        <section className="border-y bg-muted/40">
          <div className="mx-auto grid max-w-5xl gap-8 px-4 py-16 sm:grid-cols-2">
            <div className="space-y-4">
              <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <ShieldCheck className="size-6 text-brand" aria-hidden /> Security
              </h2>
              <ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
                {security.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <div className="space-y-4">
              <h2 className="text-2xl font-semibold tracking-tight">Coming next</h2>
              <ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
                {soon.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Planned, not yet available. Dates are not promised.
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl space-y-6 px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
          <dl className="grid gap-6 sm:grid-cols-2">
            {[
              [
                'Do I need to replace anything?',
                'No. Kestrel watches the equipment you already have. Devices without a driver can still be recorded as assets.',
              ],
              [
                'What does the gateway need?',
                'A Windows PC or a Docker host on the network with your devices. It only makes outbound connections.',
              ],
              [
                'What happens after the trial?',
                'Your rooms stay monitored. Alerts, analytics and new rooms need a paid plan.',
              ],
              [
                'Can my provider manage this for me?',
                'Yes. Invite them with access limited to the sites you choose, and you can see what they did.',
              ],
            ].map(([q, a]) => (
              <div key={q} className="space-y-1">
                <dt className="font-semibold">{q}</dt>
                <dd className="text-sm text-muted-foreground">{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-t bg-muted/40">
          <div className="mx-auto max-w-5xl space-y-4 px-4 py-16 text-center">
            <h2 className="text-3xl font-semibold tracking-tight">
              See your estate in an afternoon
            </h2>
            <p className="text-muted-foreground">
              5 rooms, every feature, 30 days. No card needed.
            </p>
            <Link href="/signup" className={buttonVariants({ size: 'lg' })}>
              Start free trial
            </Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-muted-foreground">
        <span>Kestrel</span>
        <span className="flex gap-4">
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
        </span>
      </footer>
    </div>
  );
}
