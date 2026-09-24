'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Check } from 'lucide-react';
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

const STEPS = ['Organisation', 'First site', 'First room'] as const;

export function OnboardingWizard({ email, hasOrgs }: { email: string; hasOrgs: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');
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
        setStep(1);
      },
    }),
  );
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
            {step === 0 && (
              <form
                className="space-y-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  createOrg.mutate({ name: orgName });
                }}
              >
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">Name your organisation</h1>
                  <p className="text-sm text-muted-foreground">
                    Usually your company or team. You can rename it later and invite others.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org">Organisation name</Label>
                  <Input
                    id="org"
                    required
                    autoFocus
                    placeholder="Acme AV"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                </div>
                {createOrg.error && (
                  <p className="text-sm text-destructive">{createOrg.error.message}</p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={createOrg.isPending || !orgName.trim()}
                >
                  {createOrg.isPending && <Spinner />}
                  Continue
                </Button>
              </form>
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
