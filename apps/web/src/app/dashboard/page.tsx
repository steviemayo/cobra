'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTRPC } from '@/trpc/client';
import { createSupabaseBrowser } from '@/lib/supabase/client';

const input = 'rounded bg-slate-900 p-2';
const btn = 'rounded bg-sky-600 px-3 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50';

export default function Dashboard() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const orgs = useQuery(trpc.org.mine.queryOptions());
  const [orgName, setOrgName] = useState('');
  const [siteName, setSiteName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomType, setRoomType] = useState<'meeting' | 'training'>('meeting');
  const [siteId, setSiteId] = useState('');

  const org = orgs.data?.[0];
  const orgId = org?.id ?? '';
  const sites = useQuery({ ...trpc.site.list.queryOptions({ orgId }), enabled: !!orgId });
  const rooms = useQuery({ ...trpc.room.list.queryOptions({ orgId }), enabled: !!orgId });

  const createOrg = useMutation(
    trpc.org.create.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.org.mine.queryKey() }),
    }),
  );
  const createSite = useMutation(
    trpc.site.create.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.site.list.queryKey() }),
    }),
  );
  const createRoom = useMutation(
    trpc.room.create.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.room.list.queryKey() }),
    }),
  );

  async function signOut() {
    await createSupabaseBrowser().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{org ? org.name : 'Kestrel'}</h1>
        <button className="text-sm text-slate-400 underline" onClick={signOut}>
          Sign out
        </button>
      </header>

      {orgs.isSuccess && !org && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createOrg.mutate({ name: orgName });
          }}
        >
          <input
            className={input}
            required
            placeholder="Organisation name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
          />
          <button className={btn} disabled={createOrg.isPending}>
            Create organisation
          </button>
        </form>
      )}

      {org && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Sites</h2>
            <ul className="space-y-1">
              {sites.data?.map((s) => (
                <li key={s.id}>{s.name}</li>
              ))}
            </ul>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                createSite.mutate({ orgId, name: siteName }, { onSuccess: () => setSiteName('') });
              }}
            >
              <input
                className={input}
                required
                placeholder="Site name"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
              />
              <button className={btn} disabled={createSite.isPending}>
                Add site
              </button>
            </form>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-medium">Rooms</h2>
            <ul className="space-y-1">
              {rooms.data?.map((r) => (
                <li key={r.id}>
                  <Link href={`/rooms/${r.id}`} className="text-sky-400 hover:underline">
                    {r.name}
                  </Link>{' '}
                  <span className="text-sm text-slate-400">({r.type})</span>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                createRoom.mutate(
                  {
                    orgId,
                    siteId: siteId || sites.data?.[0]?.id || '',
                    name: roomName,
                    type: roomType,
                  },
                  { onSuccess: () => setRoomName('') },
                );
              }}
            >
              <input
                className={input}
                required
                placeholder="Room name"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
              <select
                className={input}
                value={roomType}
                onChange={(e) => setRoomType(e.target.value as 'meeting' | 'training')}
              >
                <option value="meeting">Meeting room</option>
                <option value="training">Training room</option>
              </select>
              <select className={input} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className={btn} disabled={createRoom.isPending || !sites.data?.length}>
                Add room
              </button>
            </form>
            {createRoom.error && <p className="text-sm text-red-400">{createRoom.error.message}</p>}
          </section>
        </>
      )}
    </main>
  );
}
