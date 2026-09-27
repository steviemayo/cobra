'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { isAccent } from '@/lib/accent';
import { useTRPC } from '@/trpc/client';

/**
 * How a service provider presents itself. A customer's owner can choose to show it in their portal
 * and on their panels; nothing changes for a customer until they do. Customers still pay Kestrel.
 */
export function ProviderBrandSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const current = useQuery(trpc.msp.brand.queryOptions({ orgId }));
  const [name, setName] = useState('');
  const [logo, setLogo] = useState('');
  const [accent, setAccent] = useState('');

  useEffect(() => {
    if (current.data === undefined) return;
    setName(current.data?.name ?? '');
    setLogo(current.data?.logoUrl ?? '');
    setAccent(current.data?.accent ?? '');
  }, [current.data]);

  const save = useMutation(
    trpc.msp.setBrand.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.msp.brand.queryKey({ orgId }) });
        toast.success('Brand saved');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const logoOk = !logo.trim() || /^https:\/\/\S+$/.test(logo.trim());
  const accentOk = !accent.trim() || isAccent(accent);
  const valid = name.trim().length > 0 && logoOk && accentOk;

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <div className="text-sm font-medium">Your brand</div>
        <p className="text-sm text-muted-foreground">
          Customers can choose to show your name, logo and colour in their portal and, unless they
          set their own, on their room panels. Nothing changes for a customer until their owner
          turns it on. Kestrel is still credited, and customers still pay Kestrel directly.
        </p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            orgId,
            brand: {
              name: name.trim(),
              ...(logo.trim() && { logoUrl: logo.trim() }),
              ...(accent.trim() && { accent: accent.trim() }),
            },
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="brand-name">Name customers see</Label>
          <Input
            id="brand-name"
            maxLength={60}
            disabled={!isOwner}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-logo">Logo address</Label>
          <Input
            id="brand-logo"
            placeholder="https://…"
            disabled={!isOwner}
            aria-invalid={!logoOk}
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
          />
          {!logoOk && (
            <p className="text-xs text-destructive">
              It must be a web address starting with https://
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-accent">Accent colour</Label>
          <div className="flex items-center gap-2">
            <Input
              id="brand-accent"
              placeholder="#0f8a8c"
              disabled={!isOwner}
              aria-invalid={!accentOk}
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
            {accentOk && accent.trim() && (
              <span
                aria-hidden
                className="size-6 shrink-0 rounded border"
                style={{ background: accent.trim() }}
              />
            )}
          </div>
          {!accentOk && <p className="text-xs text-destructive">Use a colour like #0f8a8c</p>}
        </div>
        <div className="flex items-center gap-3 sm:col-span-3">
          {isOwner ? (
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Spinner />} Save brand
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">An owner can change this</span>
          )}
        </div>
      </form>
    </section>
  );
}
