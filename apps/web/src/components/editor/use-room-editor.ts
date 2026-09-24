'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { RoomModel } from '@kestrel/model';
import { validateRoomModel } from '@kestrel/engine';
import { useTRPC } from '@/trpc/client';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'invalid' | 'conflict' | 'error';

const AUTOSAVE_MS = 1500;

export function useRoomEditor(args: {
  orgId: string;
  roomId: string;
  initialModel: RoomModel;
  initialRevision: number;
}) {
  const { orgId, roomId } = args;
  const trpc = useTRPC();
  const save = useMutation(trpc.draft.save.mutationOptions());

  const [model, setModel] = useState(args.initialModel);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const modelRef = useRef(model);
  const revision = useRef(args.initialRevision);
  const tick = useRef(0);
  const savedTick = useRef(0);
  const conflict = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const update = useCallback((fn: (m: RoomModel) => void) => {
    const next = structuredClone(modelRef.current);
    fn(next);
    modelRef.current = next;
    tick.current++;
    setModel(next);
    if (!conflict.current) setStatus('dirty');
  }, []);

  const flush = useCallback((): Promise<void> => {
    queue.current = queue.current.then(async () => {
      if (conflict.current || savedTick.current === tick.current) return;
      const at = tick.current;
      const parsed = RoomModel.safeParse(modelRef.current);
      if (!parsed.success) {
        setStatus('invalid');
        return;
      }
      setStatus('saving');
      try {
        const res = await save.mutateAsync({
          orgId,
          roomId,
          baseRevision: revision.current,
          model: parsed.data,
        });
        revision.current = res.revision;
        savedTick.current = at;
        setStatus(tick.current === at ? 'saved' : 'dirty');
      } catch (e) {
        if (e instanceof TRPCClientError && e.data?.code === 'CONFLICT') {
          conflict.current = true;
          setStatus('conflict');
        } else setStatus('error');
      }
    });
    return queue.current;
  }, [orgId, roomId, save]);

  useEffect(() => {
    if (status !== 'dirty') return;
    const t = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [model, status, flush]);

  useEffect(() => {
    if (status === 'saved') return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [status]);

  /** Replace the whole model with server state (after a version restore). */
  const replace = useCallback((next: RoomModel, nextRevision: number) => {
    modelRef.current = next;
    revision.current = nextRevision;
    tick.current++;
    savedTick.current = tick.current;
    setModel(next);
    setStatus('saved');
  }, []);

  const validation = useMemo(() => validateRoomModel(model), [model]);

  return { model, update, status, flush, replace, validation };
}
