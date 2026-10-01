'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Copy } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { buttonVariants } from '@/components/ui/button';
import { STARTER, preview, readFeedback } from '@/lib/driver-example';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { id: 'before', title: 'Before you start' },
  { id: 'write', title: '1. Write the driver' },
  { id: 'commands', title: '2. Commands and values' },
  { id: 'feedback', title: '3. Feedback' },
  { id: 'test', title: '4. Test it' },
  { id: 'ship', title: '5. Use it in a room' },
  { id: 'problems', title: 'Common problems' },
] as const;

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em]">{children}</code>;
}

function Block({ text, copy }: { text: string; copy?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      {copy && (
        <button
          type="button"
          aria-label="Copy"
          className="absolute right-2 top-2 rounded-md border bg-background p-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            try {
              void navigator.clipboard.writeText(text).then(() => {
                setDone(true);
                setTimeout(() => setDone(false), 1500);
              });
            } catch {
              // Clipboard blocked: the text is still selectable.
            }
          }}
        >
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="border-b bg-muted/40 text-xs">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-1.5">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm leading-relaxed">{children}</p>
);
const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">{children}</ul>
);
const Steps = ({ children }: { children: React.ReactNode }) => (
  <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed">{children}</ol>
);

export function DriverGuideView() {
  const { orgId } = useOrg();
  const json = useMemo(() => JSON.stringify(STARTER, null, 2), []);

  // Every example below is worked out from the example driver, so it always matches the real format.
  const sent = useMemo(() => {
    const at = (key: string, sample: Parameters<typeof preview>[1]) =>
      preview(STARTER, sample).find((c) => c.key === key)?.text ?? '';
    return [
      ['Power on', 'power.on', at('power.on', {})],
      ['Volume at the bottom', 'volume, level 0', at('volume', { level: 0 })],
      ['Volume in the middle', 'volume, level 50', at('volume', { level: 50 })],
      ['Volume at the top', 'volume, level 100', at('volume', { level: 100 })],
      ['First input', 'select_input, port in1', at('select_input', { input: 'in1' })],
      ['Second input', 'select_input, port in2', at('select_input', { input: 'in2' })],
    ] as const;
  }, []);
  const heard = useMemo(
    () =>
      ['POWER=ON', 'POWER=OFF', 'POWER=STANDBY', 'power=on', 'OK'].map((line) => {
        const r = readFeedback(STARTER, line);
        return [
          line,
          r.length ? r.map((x) => `${x.set}: ${x.result}`).join(', ') : 'nothing (ignored)',
        ] as const;
      }),
    [],
  );

  return (
    <PageContainer>
      <PageHeader
        title="How to build and test a custom driver"
        description="A driver is a JSON description of one kind of device: what to send for each thing a room can ask for, and how to read the replies. No code."
        actions={
          <Link href={orgPath(orgId, '/drivers')} className={buttonVariants({ size: 'sm' })}>
            Open Custom drivers
          </Link>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[13rem_1fr]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-20 space-y-1 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-10">
          <Section id="before" title="Before you start">
            <List>
              <li>
                Creating drivers is part of the <strong>Pro</strong> plan and needs the owner or dev
                role. Any member of the organisation can read this guide.
              </li>
              <li>
                Have the device’s control manual open. You need its <strong>port</strong>, what{' '}
                <strong>ends a command</strong> (usually a carriage return and line feed), the text
                for each command, and what it replies.
              </li>
              <li>
                Check the built-in drivers first (PJLink, Crestron DM NVX, Q-SYS, Biamp Tesira,
                Extron, Kramer, LG, Sony BRAVIA, Cisco RoomOS and more). A custom driver is for a
                device they don’t cover.
              </li>
              <li>
                A driver can only talk to its own device, using the moves the format allows. It
                cannot run code or open other connections.
              </li>
            </List>
          </Section>

          <Section id="write" title="1. Write the driver">
            <Steps>
              <li>
                Open <strong>Custom drivers</strong> and choose <strong>New driver</strong>. It
                starts from the example below.
              </li>
              <li>
                Change <Code>id</Code> (lowercase letters, numbers and dashes) and <Code>name</Code>
                . Rooms refer to the driver as <Code>custom:&lt;id&gt;</Code>.
              </li>
              <li>
                Set the <Code>transport</Code>: <Code>tcp</Code> for text lines, or{' '}
                <Code>http</Code> for web requests.
              </li>
              <li>
                Replace the commands with the device’s own text, then add feedback if the device
                reports its state.
              </li>
            </Steps>
            <Block text={json} copy />
            <Table
              head={['Field', 'What it does']}
              rows={[
                [
                  <Code key="a">transport</Code>,
                  <>
                    TCP: <Code>port</Code>, <Code>terminator</Code> (what ends a command),{' '}
                    <Code>replyTerminator</Code> (when replies end differently),{' '}
                    <Code>keepOpen</Code> (hold one connection to hear unprompted messages),{' '}
                    <Code>timeoutMs</Code>. HTTP: <Code>port</Code>, <Code>https</Code>,{' '}
                    <Code>headers</Code>, <Code>timeoutMs</Code>.
                  </>,
                ],
                [
                  <Code key="b">settings</Code>,
                  <>
                    What someone fills in per device. <Code>host</Code> and <Code>port</Code> always
                    exist. Types: <Code>string</Code>, <Code>number</Code>, <Code>boolean</Code>,{' '}
                    <Code>secret</Code>. Use one in a command as <Code>{'{setting.password}'}</Code>
                    .
                  </>,
                ],
                [
                  <Code key="c">commands</Code>,
                  'What to send for each thing a room can ask for (next section).',
                ],
                [
                  <Code key="d">volumeScale</Code>,
                  <>
                    Maps the room’s 0 to 100 onto the device’s own range, and back when reading
                    feedback.
                  </>,
                ],
                [
                  <Code key="e">feedback</Code>,
                  'Poll the device on a timer, and read its replies (section 3).',
                ],
                [
                  <Code key="f">class</Code>,
                  <>
                    Optional. The kind of device (display, projector, camera…). A driver that names
                    a class must supply the commands that class needs; Check tells you which are
                    missing.
                  </>,
                ],
                [
                  <Code key="g">quickActions</Code>,
                  <>
                    Optional. Panel buttons the device supports: <Code>display.blank</Code> needs{' '}
                    <Code>blank.on</Code> and <Code>blank.off</Code>; <Code>mics.privacy_mute</Code>{' '}
                    needs <Code>mute.on</Code> and <Code>mute.off</Code>.
                  </>,
                ],
              ]}
            />
          </Section>

          <Section id="commands" title="2. Commands and values">
            <P>
              A command is a name a room can ask for, and the text (TCP) or request (HTTP) to send.
              Add <Code>expect</Code>, a regular expression the reply must match, if you want
              Kestrel to know the device accepted it.
            </P>
            <Table
              head={['Command', 'Gets these values']}
              rows={[
                [<Code key="1">power.on</Code>, 'none'],
                [<Code key="2">power.off</Code>, 'none'],
                [<Code key="3">mute.on / mute.off</Code>, 'none'],
                [
                  <Code key="4">volume</Code>,
                  <>
                    <Code>{'{level}'}</Code>, <Code>{'{levelHex}'}</Code> (two hex digits)
                  </>,
                ],
                [
                  <Code key="5">select_input</Code>,
                  <>
                    <Code>{'{input}'}</Code>, <Code>{'{inputNumber}'}</Code>,{' '}
                    <Code>{'{inputHex}'}</Code>
                  </>,
                ],
                [
                  <Code key="6">route</Code>,
                  <>
                    <Code>{'{input}'}</Code>, <Code>{'{output}'}</Code>,{' '}
                    <Code>{'{inputNumber}'}</Code>, <Code>{'{outputNumber}'}</Code>
                  </>,
                ],
                [<Code key="7">preset, camera_preset, scene</Code>, <Code>{'{name}'}</Code>],
                [<Code key="8">record.on / record.off, blank.on / blank.off</Code>, 'none'],
                [<Code key="9">app.launch</Code>, <Code>{'{appId}'}</Code>],
                [<Code key="10">key.up, key.down, key.ok, key.back…</Code>, 'none (remote keys)'],
                [
                  <Code key="11">command.&lt;name&gt;</Code>,
                  <>
                    anything device specific, such as <Code>command.open</Code> for blinds or{' '}
                    <Code>command.down</Code> for a screen
                  </>,
                ],
              ]}
            />
            <List>
              <li>
                A port id such as <Code>in2</Code> gives <Code>{'{inputNumber}'}</Code> = 2. Use{' '}
                <Code>{'{input}'}</Code> when the device wants the whole id.
              </li>
              <li>
                <Code>{'{level}'}</Code> is already scaled by <Code>volumeScale</Code>. With a scale
                of 0 to 30, a room level of 50 sends 15.
              </li>
              <li>
                HTTP commands use <Code>method</Code> (GET, POST or PUT), <Code>path</Code> (starts
                with <Code>/</Code>), <Code>body</Code> and optional per-command{' '}
                <Code>headers</Code>.
              </li>
              <li>
                Values are cleaned for where they land: control characters are stripped from text,
                URL paths are percent-encoded, JSON bodies are escaped. A preset name cannot smuggle
                in a second command.
              </li>
            </List>
          </Section>

          <Section id="feedback" title="3. Feedback">
            <P>
              Feedback lets the room show the device’s real state instead of what it was last told.
              It is optional.
            </P>
            <List>
              <li>
                <Code>poll</Code>: actions sent on a timer (every 1 to 300 seconds) to ask the
                device for its state.
              </li>
              <li>
                <Code>patterns</Code>: regular expressions tried on every line (TCP) or reply body
                (HTTP). Each has <Code>set</Code> (one of <Code>power</Code>, <Code>muted</Code>,{' '}
                <Code>volume</Code>, <Code>input</Code>, <Code>preset</Code>, <Code>blanked</Code>,{' '}
                <Code>online</Code>) and <Code>value</Code>: a literal (<Code>on</Code>,{' '}
                <Code>off</Code>, <Code>true</Code>, <Code>false</Code>) or <Code>$1</Code> for the
                first group in the match.
              </li>
              <li>
                Every pattern that matches applies, so one line can set several things. Regular
                expressions are case sensitive.
              </li>
              <li>
                Reading a volume needs <Code>volumeScale</Code> so it can be shown as 0 to 100. A
                TCP driver with patterns needs <Code>keepOpen</Code> or something to poll.
              </li>
            </List>
          </Section>

          <Section id="test" title="4. Test it">
            <P>
              Test from the cheapest check to the most real. Each stage catches a different kind of
              mistake, so don’t skip ahead to a real device.
            </P>

            <h3 className="pt-1 text-sm font-semibold">
              Stage 1: Check (does the driver make sense?)
            </h3>
            <P>
              Press <strong>Check</strong> in the editor. It reports the mistakes a room would only
              hit later: unknown commands, a placeholder a command doesn’t get, a regular expression
              that doesn’t compile, a pattern that uses <Code>$2</Code> with one group, a missing
              command for the driver’s class or quick action. <strong>Looks good</strong> means it
              passed. Save runs the same check.
            </P>

            <h3 className="pt-1 text-sm font-semibold">
              Stage 2: Sent-text cases (does it send what the manual says?)
            </h3>
            <P>
              The editor’s <strong>What it would send</strong> panel shows each command with sample
              values (level 50, port in2, output out1, name “Movie”). Compare every line with the
              manual. Then test the edges, because that is where scaling and numbering go wrong. For
              the example driver above:
            </P>
            <Table
              head={['Case', 'Request', 'Sends', 'Compare with the manual']}
              rows={sent.map(([name, req, text]) => [
                name,
                <Code key="r">{req}</Code>,
                <Code key="t">{text}</Code>,
                <span key="m" className="text-muted-foreground">
                  Does the device accept exactly this?
                </span>,
              ])}
            />
            <P>The cases worth having for any driver:</P>
            <List>
              <li>
                Lowest and highest volume: the ends of the range, and that a mid level lands where
                you expect.
              </li>
              <li>
                First and last input or output: numbering that starts at 0 on the device but 1 in
                Kestrel is the most common bug.
              </li>
              <li>
                A name with a space or a symbol in a <Code>preset</Code> or <Code>scene</Code>, and
                how the device wants it quoted.
              </li>
              <li>Every command you plan to use, not just power.</li>
            </List>

            <h3 className="pt-1 text-sm font-semibold">
              Stage 3: Reply cases (does it read the device correctly?)
            </h3>
            <P>
              For each pattern, write down a reply the device really sends and what the room should
              believe, plus a reply it must ignore. For the example driver, patterns are{' '}
              <Code>{'^POWER=(ON|OFF)'}</Code> setting <Code>power</Code> to <Code>$1</Code>:
            </P>
            <Table
              head={['Device sends', 'The room believes']}
              rows={heard.map(([line, result]) => [<Code key="l">{line}</Code>, result])}
            />
            <List>
              <li>
                <Code>POWER=STANDBY</Code> is ignored because the pattern only knows ON and OFF. If
                your device has a third state, add a pattern for it.
              </li>
              <li>
                <Code>power=on</Code> is ignored because matching is case sensitive. Copy replies
                exactly from a real capture or the manual.
              </li>
            </List>
            <P>
              Get real replies by connecting to the device with a terminal tool (for example PuTTY
              in raw mode, or <Code>nc host port</Code>), typing a command and copying what comes
              back.
            </P>

            <h3 className="pt-1 text-sm font-semibold">
              Stage 4: Command line (repeatable, keep in version control)
            </h3>
            <P>
              For drivers kept as files in the repository, the same checks run from a terminal, so
              they can be part of a review:
            </P>
            <Block
              copy
              text={`pnpm --filter @kestrel/drivers driver validate my-driver.json
pnpm --filter @kestrel/drivers driver render my-driver.json --level=0 --input=in1
pnpm --filter @kestrel/drivers driver render my-driver.json --level=100 --input=in8 --output=out4 --name="Movie Night"`}
            />
            <P>
              <Code>validate</Code> is Check. <Code>render</Code> prints each command exactly as it
              goes on the wire, including the terminator, so a stray space or a wrong line ending is
              visible.
            </P>

            <h3 className="pt-1 text-sm font-semibold">Stage 5: Real device</h3>
            <Steps>
              <li>
                Save the driver, then in the room’s design set the device’s control to{' '}
                <strong>Driver</strong> and pick your driver.
              </li>
              <li>
                On the room’s <strong>Setup</strong> tab, enter the device’s address and any login.
                Anything marked “Needs setup” must be filled in.
              </li>
              <li>
                Assign the room to a gateway, publish the room and let the gateway apply it (about a
                minute).
              </li>
              <li>
                Press <strong>Test connection</strong> on the device. “Answers” means the gateway
                reached it and it replied; otherwise you get a plain-language reason.
              </li>
              <li>
                Run through the room’s activities on the panel or Room control page: power on, each
                input, volume up and down, mute, power off. Watch that the panel’s state follows the
                device, which proves feedback.
              </li>
              <li>
                Power the device off at the wall, then on again. It should come back online without
                a restart of anything else.
              </li>
            </Steps>
            <P>
              Test connection checks what the room is <em>running now</em>, so after every driver
              change, publish again and wait before you test.
            </P>

            <h3 className="pt-1 text-sm font-semibold">
              Stage 6: Automated tests (for Kestrel developers)
            </h3>
            <P>
              For a driver you intend to keep, add a regression test so a later change can’t break
              it. The driver tests in <Code>packages/drivers/src/real/declarative.test.ts</Code>{' '}
              show the pattern:
            </P>
            <List>
              <li>
                Start a fake device: a small TCP or HTTP server on a random local port that answers
                with the replies from your Stage 3 cases.
              </li>
              <li>
                Create a <Code>DeclarativeDriver</Code> pointed at it, with the driver’s JSON as the
                spec.
              </li>
              <li>Run a command and assert the fake received exactly the text from Stage 2.</li>
              <li>
                Have the fake send each reply and assert the driver’s state (power, volume, muted…)
                is what Stage 3 says.
              </li>
              <li>
                Assert the failure paths too: a reply that doesn’t match <Code>expect</Code>, and a
                device that never answers, should each give a clear error and not hang.
              </li>
            </List>
          </Section>

          <Section id="ship" title="5. Use it in a room">
            <List>
              <li>
                Every save is a new <strong>version</strong>, and versions are never changed after
                saving.
              </li>
              <li>
                A release pins the exact driver version it was built with (it is inside the signed
                release). Editing a driver never changes a room that is already running.
              </li>
              <li>
                To roll a fix out, save the driver, publish each room that uses it, and re-run Stage
                5.
              </li>
              <li>
                Deleting a driver doesn’t affect running rooms, but rooms that use it can’t be
                published until you choose another.
              </li>
              <li>
                Publishing a room as a marketplace template strips device settings, so addresses and
                passwords never leave your organisation.
              </li>
            </List>
          </Section>

          <Section id="problems" title="Common problems">
            <Table
              head={['You see', 'Why', 'Fix']}
              rows={[
                [
                  '“… is not a command Kestrel knows”',
                  'The command name isn’t in the list.',
                  <>
                    Use a name from section 2, or <Code key="a">command.&lt;name&gt;</Code>.
                  </>,
                ],
                [
                  '“{x} is not available here”',
                  'That command doesn’t get that value.',
                  'Check the values table. A typo shows here rather than sending empty text.',
                ],
                [
                  '“a TCP driver needs “send””',
                  'A TCP driver’s commands use send. HTTP uses path.',
                  'Match the command fields to the transport.',
                ],
                [
                  '“uses $2 but the pattern has 1 group”',
                  'The value asks for a group the pattern doesn’t capture.',
                  'Add a bracketed group, or use $1.',
                ],
                [
                  '“reading a volume needs volumeScale”',
                  'The device’s number can’t be shown as 0 to 100.',
                  'Add volumeScale with the device’s min and max.',
                ],
                [
                  '“Feedback patterns … need keepOpen or something to poll”',
                  'Nothing would ever deliver a reply to read.',
                  <>
                    Set <Code key="b">keepOpen</Code> or add a poll action.
                  </>,
                ],
                [
                  'Unknown field error',
                  'The format rejects unknown fields so a typo can’t silently do nothing.',
                  'Fix the spelling of the field named.',
                ],
                [
                  'Test connection: “did not answer”',
                  'Wrong address or port, a firewall, or the device’s network control is off.',
                  'Check the address on Setup and that IP control is enabled on the device.',
                ],
                [
                  '“sent an unexpected reply”',
                  'The reply didn’t match expect.',
                  'Capture the real reply and loosen or correct the expression.',
                ],
              ]}
            />
            <P>
              Limits: up to 30 settings, 40 feedback patterns, 10 poll actions per driver, 50
              drivers per organisation and 100 versions per driver. The full format reference is{' '}
              <Code>docs/driver-sdk.md</Code> in the repository.
            </P>
          </Section>

          <div className={cn('flex flex-wrap gap-2 border-t pt-6')}>
            <Link href={orgPath(orgId, '/drivers')} className={buttonVariants()}>
              Open Custom drivers
            </Link>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
