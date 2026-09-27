'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Building2, Check, Handshake } from 'lucide-react';
import { toast } from 'sonner';
import { RoomType } from '@kestrel/model';
import { Logo } from '@/components/brand/logo';
import { SimpleSelect } from '@/components/common/simple-select';
import { timezoneOptions } from '@/components/shell/dialogs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ROOM_TYPE_LABEL } from '@/lib/format';
import { rememberOrg } from '@/lib/last-org';
import { createSupabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

const STEPS = ['Organisation', 'First site', 'First room'] as const;

type Kind = 'customer' | 'msp';
// kind: which sort of organisation. name: what it is called. similar: it may already exist.
// waiting: the person asked to join one and is waiting for its owners.
type Stage = 'kind' | 'name' | 'similar' | 'waiting';
type Similar = RouterOutputs['org']['checkDuplicate'];

const KIND_CHOICES: {
  kind: Kind;
  icon: typeof Building2;
  title: string;
  description: string;
}[] = [
  {
    kind: 'customer',
    icon: Building2,
    title: 'I manage rooms for my own organisation',
    description: 'Design, deploy and monitor the AV systems in your own buildings.',
  },
  {
    kind: 'msp',
    icon: Handshake,
    title: 'I look after other organisations’ systems',
    description:
      'A service provider. Customers connect to you and give you access; you have no rooms of your own.',
  },
];

export function OnboardingWizard({
  email,
  hasOrgs,
  initialKind,
}: {
  email: string;
  hasOrgs: boolean;
  /** Preselects a card, from a "sign up as a service provider" link. */
  initialKind: Kind | null;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [stage, setStage] = useState<Stage>('kind');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');
  // A managed service provider looks after other organisations; it has no rooms of its own.
  const [kind, setKind] = useState<Kind | null>(initialKind);
  const [similar, setSimilar] = useState<Similar | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Someone waiting for owners to approve can still choose to make their own organisation.
  const [ownInstead, setOwnInstead] = useState(false);
  const [siteName, setSiteName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [roomName, setRoomName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('meeting');

  const finish = (path: string) => {
    if (orgId) rememberOrg(orgId);
    router.replace(path);
    router.refresh();
  };

  const createOrg = useMutation(
    trpc.org.create.mutationOptions({
      onSuccess: (org) => {
        setOrgId(org.id);
        rememberOrg(org.id);
        if (org.trial === 'used')
          toast.info(
            'You or a colleague already used a free trial, so this organisation starts without one. You can upgrade any time.',
            { duration: 12_000 },
          );
        if (org.kind === 'msp') {
          router.replace(`/o/${org.id}/msp`);
          router.refresh();
          return;
        }
        setStep(1);
      },
    }),
  );
  const requests = useQuery(trpc.joinRequest.mine.queryOptions());
  const waitingFor = requests.data?.find((r) => r.status === 'pending');
  const declined = requests.data?.filter((r) => r.status === 'declined') ?? [];
  const requestJoin = useMutation(
    trpc.joinRequest.create.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.joinRequest.mine.queryKey() });
        setOwnInstead(false);
        setStage('waiting');
      },
    }),
  );
  const cancelRequest = useMutation(
    trpc.joinRequest.cancel.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.joinRequest.mine.queryKey() });
        setStage('kind');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // Look for an organisation that may already be theirs before making a new one.
  async function continueFromName() {
    if (!kind) return;
    setChecking(true);
    setCheckError(null);
    try {
      const found = await qc.fetchQuery({
        ...trpc.org.checkDuplicate.queryOptions({ name: orgName, kind }),
        staleTime: 0,
      });
      if (found.colleagues.length === 0 && !found.similarName) {
        createOrg.mutate({ name: orgName, kind });
      } else {
        setSimilar(found);
        setStage('similar');
      }
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setChecking(false);
    }
  }
  const createSite = useMutation(
    trpc.site.create.mutationOptions({
      onSuccess: (site) => {
        setSiteId(site.id);
        setStep(2);
      },
    }),
  );
  const createRoom = useMutation(
    trpc.room.create.mutationOptions({
      onSuccess: (room) => finish(`/o/${orgId}/rooms/${room.id}/design`),
    }),
  );

  // Someone with a request waiting (and no organisation yet) lands on the waiting screen.
  const shown: Stage = !hasOrgs && waitingFor && !ownInstead && stage === 'kind' ? 'waiting' : stage;
  const kindLabel = kind === 'msp' ? 'service provider' : 'organisation';

  async function signOut() {
    await createSupabaseBrowser().auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Logo />
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="hidden sm:inline">{email}</span>
          {hasOrgs && !orgId && (
            <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
              Cancel
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-24">
        <ol className="mb-10 flex items-center gap-3" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li key={label} className="flex flex-1 items-center gap-3 last:flex-none">
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full border text-xs transition-colors',
                  i < step && 'border-brand bg-brand text-brand-foreground',
                  i === step && 'border-brand text-brand',
                  i > step && 'text-muted-foreground',
                )}
              >
                {i < step ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-sm',
                  i === step ? 'font-medium' : 'hidden text-muted-foreground sm:inline',
                )}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
            </li>
          ))}
        </ol>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.2 }}
          >
            {step === 0 && shown === 'waiting' && waitingFor && (
              <div className="space-y-6">
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Waiting for {waitingFor.orgName}
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    We’ve asked the owners to add you. You’ll get in as soon as one approves, and
                    they choose what you can do. Come back to this page or sign in again to check.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Button size="lg" onClick={() => router.replace('/')}>
                    Check again
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={cancelRequest.isPending}
                    onClick={() => cancelRequest.mutate({ requestId: waitingFor.id })}
                  >
                    {cancelRequest.isPending && <Spinner />}
                    Cancel my request
                  </Button>
                  <Button variant="ghost" size="lg" onClick={() => setOwnInstead(true)}>
                    Create my own organisation instead
                  </Button>
                </div>
              </div>
            )}

            {step === 0 && shown === 'kind' && (
              <form
                className="space-y-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (kind) setStage('name');
                }}
              >
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    What are you setting up?
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    This decides what your account can do, and it can’t be changed afterwards.
                  </p>
                </div>
                {declined.map((r) => (
                  <p key={r.id} className="rounded-lg border bg-muted/40 p-3 text-sm">
                    The owners of {r.orgName} declined your request. Ask them to invite you, or set
                    up your own below.
                  </p>
                ))}
                <div className="grid gap-2" role="radiogroup" aria-label="Type of organisation">
                  {KIND_CHOICES.map((c) => (
                    <button
                      key={c.kind}
                      type="button"
                      role="radio"
                      aria-checked={kind === c.kind}
                      onClick={() => setKind(c.kind)}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border p-4 text-left transition-colors',
                        kind === c.kind ? 'border-brand bg-accent' : 'hover:bg-muted',
                      )}
                    >
                      <c.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      <span>
                        <span className="block text-sm font-medium">{c.title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {c.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <Button type="submit" size="lg" className="w-full" disabled={!kind}>
                  Continue
                </Button>
              </form>
            )}

            {step === 0 && shown === 'name' && (
              <form
                className="space-y-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  void continueFromName();
                }}
              >
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Name your {kindLabel}
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    Usually your company or team. You can rename it later and invite others.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org">{kind === 'msp' ? 'Company name' : 'Organisation name'}</Label>
                  <Input
                    id="org"
                    required
                    autoFocus
                    placeholder="Acme AV"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                </div>
                {(checkError || createOrg.error) && (
                  <p className="text-sm text-destructive">
                    {checkError ?? createOrg.error?.message}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="lg" onClick={() => setStage('kind')}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    size="lg"
                    className="flex-1"
                    disabled={checking || createOrg.isPending || !orgName.trim()}
                  >
                    {(checking || createOrg.isPending) && <Spinner />}
                    Continue
                  </Button>
                </div>
              </form>
            )}

            {step === 0 && shown === 'similar' && similar && kind && (
              <div className="space-y-6">
                {similar.colleagues.length > 0 ? (
                  <>
                    <div className="space-y-1.5">
                      <h1 className="text-2xl font-semibold tracking-tight">
                        Someone at your company already uses Kestrel
                      </h1>
                      <p className="text-sm text-muted-foreground">
                        These {kind === 'msp' ? 'service providers' : 'organisations'} belong to
                        colleagues with your email domain. Ask to join one and its owners will be
                        told. Nothing else about you is shared.
                      </p>
                    </div>
                    <ul className="space-y-2">
                      {similar.colleagues.map((c) => (
                        <li
                          key={c.id}
                          className="flex items-center justify-between gap-3 rounded-lg border p-3"
                        >
                          <span className="min-w-0 truncate text-sm font-medium">{c.name}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              c.requested ||
                              (requestJoin.isPending && requestJoin.variables?.orgId === c.id)
                            }
                            onClick={() => requestJoin.mutate({ orgId: c.id })}
                          >
                            {requestJoin.isPending && requestJoin.variables?.orgId === c.id && (
                              <Spinner />
                            )}
                            {c.requested ? 'Requested' : 'Request to join'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {requestJoin.error && (
                      <p className="text-sm text-destructive">{requestJoin.error.message}</p>
                    )}
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <h1 className="text-2xl font-semibold tracking-tight">
                      A similar name already exists
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {kind === 'msp' ? 'A service provider' : 'An organisation'} called something
                      very close to “{orgName.trim()}” is already on Kestrel. If it’s your company,
                      ask one of its owners to invite you. If not, carry on and create yours.
                    </p>
                  </div>
                )}
                {createOrg.error && (
                  <p className="text-sm text-destructive">{createOrg.error.message}</p>
                )}
                <div className="flex flex-col gap-2">
                  <Button
                    variant={similar.colleagues.length > 0 ? 'outline' : 'default'}
                    size="lg"
                    disabled={createOrg.isPending}
                    onClick={() => createOrg.mutate({ name: orgName, kind })}
                  >
                    {createOrg.isPending && <Spinner />}
                    {similar.colleagues.length > 0
                      ? `Create a separate ${kindLabel}`
                      : `Create “${orgName.trim()}”`}
                  </Button>
                  <Button variant="ghost" size="lg" onClick={() => setStage('name')}>
                    Back
                  </Button>
                </div>
              </div>
            )}

            {step === 1 && (
              <form
                className="space-y-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  createSite.mutate({ orgId: orgId!, name: siteName, timezone });
                }}
              >
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">Add your first site</h1>
                  <p className="text-sm text-muted-foreground">
                    A site is a building or campus. Rooms live inside sites.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="site">Site name</Label>
                  <Input
                    id="site"
                    required
                    autoFocus
                    placeholder="Sydney HQ"
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tz">Timezone</Label>
                  <SimpleSelect
                    id="tz"
                    className="w-full"
                    value={timezone}
                    onValueChange={setTimezone}
                    options={timezoneOptions()}
                  />
                </div>
                {createSite.error && (
                  <p className="text-sm text-destructive">{createSite.error.message}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    onClick={() => finish(`/o/${orgId}`)}
                  >
                    Skip for now
                  </Button>
                  <Button
                    type="submit"
                    size="lg"
                    className="flex-1"
                    disabled={createSite.isPending || !siteName.trim()}
                  >
                    {createSite.isPending && <Spinner />}
                    Continue
                  </Button>
                </div>
              </form>
            )}

            {step === 2 && (
              <form
                className="space-y-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  createRoom.mutate({
                    orgId: orgId!,
                    siteId: siteId!,
                    name: roomName,
                    type: roomType,
                  });
                }}
              >
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">Add your first room</h1>
                  <p className="text-sm text-muted-foreground">
                    You’ll pick a starting template and open the designer next.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="room">Room name</Label>
                  <Input
                    id="room"
                    required
                    autoFocus
                    placeholder="Boardroom 1"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Room type</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {RoomType.options.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setRoomType(t)}
                        className={cn(
                          'rounded-lg border p-3 text-left text-sm transition-colors',
                          roomType === t ? 'border-brand bg-accent' : 'hover:bg-muted',
                        )}
                      >
                        <div className="font-medium">{ROOM_TYPE_LABEL[t]}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {t === 'meeting'
                            ? 'Present and video calls'
                            : 'Presenter, audience, recording'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                {createRoom.error && (
                  <p className="text-sm text-destructive">{createRoom.error.message}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    onClick={() => finish(`/o/${orgId}`)}
                  >
                    Skip for now
                  </Button>
                  <Button
                    type="submit"
                    size="lg"
                    className="flex-1"
                    disabled={createRoom.isPending || !roomName.trim()}
                  >
                    {createRoom.isPending && <Spinner />}
                    Create room and open designer
                  </Button>
                </div>
              </form>
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
