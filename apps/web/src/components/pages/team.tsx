'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Plus, UserMinus, X } from 'lucide-react';
import { toast } from 'sonner';
import { OrgRole } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ROLE_LABEL, formatDate, timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Member = RouterOutputs['member']['list'][number];

const ROLE_HELP: Record<OrgRole, string> = {
  owner: 'Full control, including team, billing and settings.',
  dev: 'Create and edit sites, rooms and designs.',
  support: 'View everything and use support tools. Cannot edit designs.',
  customer_viewer: 'Read-only view of room status.',
};

const roleOptions = OrgRole.options.map((r) => ({ value: r, label: ROLE_LABEL[r] }));

export function TeamView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const members = useQuery(trpc.member.list.queryOptions({ orgId }));
  const invites = useQuery({ ...trpc.invite.list.queryOptions({ orgId }), enabled: isOwner });
  const requests = useQuery({
    ...trpc.joinRequest.list.queryOptions({ orgId }),
    enabled: isOwner,
    refetchInterval: 60_000,
  });
  // The role each waiting request will get if approved. Lowest by default: the owner chooses.
  const [roles, setRoles] = useState<Record<string, OrgRole>>({});
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.member.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.invite.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.joinRequest.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.joinRequest.count.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
    ]);

  const setRole = useMutation(
    trpc.member.updateRole.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Role updated');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.member.remove.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Removed from the organisation');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const approve = useMutation(
    trpc.joinRequest.approve.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Added to the team');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const decline = useMutation(
    trpc.joinRequest.decline.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Request declined');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.invite.revoke.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Invitation revoked');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Team"
        description="People with access to this organisation."
        actions={
          isOwner && (
            <Button size="sm" onClick={() => setInviting(true)}>
              <Plus data-icon="inline-start" /> Invite people
            </Button>
          )
        }
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Members</h2>
        {members.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Person</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Joined</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data?.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      {m.email ?? 'Unknown'}
                      {m.isYou && (
                        <Badge variant="secondary" className="ml-2">
                          You
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {isOwner ? (
                        <SimpleSelect
                          size="sm"
                          value={m.role}
                          options={roleOptions}
                          onValueChange={(role) =>
                            role !== m.role && setRole.mutate({ orgId, memberId: m.id, role })
                          }
                        />
                      ) : (
                        <span className="text-muted-foreground">{ROLE_LABEL[m.role]}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDate(m.createdAt)}
                    </TableCell>
                    <TableCell>
                      {(isOwner || m.isYou) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={m.isYou ? 'Leave organisation' : `Remove ${m.email}`}
                          onClick={() => setRemoving(m)}
                        >
                          <UserMinus />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {isOwner && !!requests.data?.length && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Requests to join</h2>
          <p className="text-sm text-muted-foreground">
            These people have an email address at the same company as one of your owners and asked
            to be added. Choose what they can do, or decline.
          </p>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableBody>
                {requests.data.map((r) => {
                  const role = roles[r.id] ?? 'customer_viewer';
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {r.email}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          asked {timeAgo(r.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <SimpleSelect
                          size="sm"
                          value={role}
                          options={roleOptions}
                          onValueChange={(v) => setRoles((s) => ({ ...s, [r.id]: v }))}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate({ orgId, requestId: r.id, role })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={decline.isPending}
                            onClick={() => decline.mutate({ orgId, requestId: r.id })}
                          >
                            Decline
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Pending invitations</h2>
          {invites.data?.length ? (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableBody>
                  {invites.data.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.email}</TableCell>
                      <TableCell className="text-muted-foreground">{ROLE_LABEL[i.role]}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {i.expired ? 'Expired' : `Sent ${timeAgo(i.createdAt)}`}
                      </TableCell>
                      <TableCell className="w-12">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke invitation for ${i.email}`}
                          onClick={() => revoke.mutate({ orgId, inviteId: i.id })}
                        >
                          <X />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          )}
        </section>
      )}

      <InviteDialog open={inviting} onOpenChange={setInviting} onCreated={refresh} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        destructive
        title={removing?.isYou ? 'Leave this organisation?' : `Remove ${removing?.email}?`}
        description={
          removing?.isYou
            ? 'You’ll lose access unless someone invites you again.'
            : 'They’ll lose access immediately.'
        }
        confirmLabel={removing?.isYou ? 'Leave' : 'Remove'}
        onConfirm={() => removing && remove.mutate({ orgId, memberId: removing.id })}
      />
    </PageContainer>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('dev');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation(
    trpc.invite.create.mutationOptions({
      onSuccess: (res) => {
        setLink(`${window.location.origin}/invite/${res.token}`);
        onCreated();
      },
    }),
  );

  const close = (o: boolean) => {
    if (!o) {
      setEmail('');
      setLink(null);
      setCopied(false);
      create.reset();
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        {link ? (
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle>Invitation ready</DialogTitle>
              <DialogDescription>
                Send this link to {email}. It works once, only for that email address, and expires
                in 7 days. It won’t be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5">
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{link}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
              >
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ orgId, email, role });
            }}
          >
            <DialogHeader>
              <DialogTitle>Invite someone</DialogTitle>
              <DialogDescription>
                You’ll get a link to send them. Email delivery isn’t set up yet.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                autoFocus
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <SimpleSelect
                id="invite-role"
                className="w-full"
                value={role}
                options={roleOptions}
                onValueChange={setRole}
              />
              <p className="text-xs text-muted-foreground">{ROLE_HELP[role]}</p>
            </div>
            {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !email.trim()}>
                {create.isPending && <Spinner />}
                Create invite link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
