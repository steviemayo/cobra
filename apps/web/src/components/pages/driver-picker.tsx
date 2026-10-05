'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  BUILT_IN_DRIVERS,
  DRIVER_GROUPS,
  DRIVER_REQUEST_NEEDS,
  DRIVER_REQUEST_PROTOCOLS,
  DRIVER_REQUEST_PROTOCOL_LABEL,
  DRIVER_REQUEST_STATUS_LABEL,
  ASSET_ONLY_CATEGORIES,
  DeviceCategory,
  assetCategoryLabel,
  type DriverGroup,
  type DriverRequestStatus,
} from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

/** One choice in the driver list. `categories` empty means it suits every category. */
export interface DriverEntry {
  value: string;
  label: string;
  group: DriverGroup | 'custom';
  make: string;
  model: string;
  categories: string[];
}

const GROUP_LABEL: Record<DriverEntry['group'], string> = {
  ...DRIVER_GROUPS,
  custom: 'Your custom drivers',
};

const GENERIC: DriverEntry[] = [
  { value: 'pjlink', label: 'Projector – Generic PJLink', group: 'generic', make: 'Generic', model: 'PJLink', categories: ['projector', 'display', 'video_destination'] },
  { value: 'tcp', label: 'Generic – TCP', group: 'generic', make: 'Generic', model: 'TCP', categories: [] },
  { value: 'serial', label: 'Generic – Serial', group: 'generic', make: 'Generic', model: 'Serial', categories: [] },
  { value: 'rest', label: 'Generic – REST', group: 'generic', make: 'Generic', model: 'REST', categories: [] },
];

const BUILT_IN: DriverEntry[] = Object.entries(BUILT_IN_DRIVERS)
  .filter(([, d]) => !d.hidden)
  .map(([value, d]) => ({
    value,
    label: d.label,
    group: d.group,
    make: d.make ?? '',
    model: d.model ?? '',
    categories: d.categories as string[],
  }));

/** Every driver this organisation can pick: Kestrel's, its own custom ones, then the generic ones. */
export function useDriverEntries(): DriverEntry[] {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const custom = useQuery(trpc.driver.options.queryOptions({ orgId }));
  return useMemo(
    () => [
      ...BUILT_IN,
      ...(custom.data ?? []).map(
        (c): DriverEntry => ({
          value: c.id,
          label: c.label,
          group: 'custom',
          make: c.make ?? '',
          model: c.model ?? '',
          categories: c.categories,
        }),
      ),
      ...GENERIC,
    ],
    [custom.data],
  );
}

/** The drivers that suit a category (those that name it, and those that suit any), most specific first. */
export function entriesForCategory(entries: DriverEntry[], category: string): DriverEntry[] {
  const order = (e: DriverEntry) => (e.group === 'generic' ? 2 : e.group === 'custom' ? 1 : 0);
  return entries
    .filter((e) => e.categories.length === 0 || e.categories.includes(category))
    .sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
}

/** A driver's id as shown to people, even when it is not in the list (a driver since removed). */
export const labelForDriver = (entries: DriverEntry[], value: string) =>
  entries.find((e) => e.value === value)?.label ?? value;

/**
 * A searchable driver list. Type a make, model or category to narrow it: "bravia", "display", "q-sys".
 * With a `category`, only the drivers that suit it are listed.
 */
export function DriverPicker({
  value,
  onChange,
  entries,
  category,
  disabled,
  deviceId,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  entries: DriverEntry[];
  category?: string;
  disabled?: boolean;
  /** The device being set up, so a driver request can say which one it is for. */
  deviceId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [query, setQuery] = useState('');
  const list = useMemo(
    () => (category ? entriesForCategory(entries, category) : entries),
    [entries, category],
  );
  const groups = useMemo(() => {
    const by = new Map<DriverEntry['group'], DriverEntry[]>();
    for (const e of list) by.set(e.group, [...(by.get(e.group) ?? []), e]);
    return [...by.entries()];
  }, [list]);
  const chosen = entries.find((e) => e.value === value);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              className={cn('w-full justify-between font-normal', className)}
            />
          }
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? (chosen?.label ?? value) : 'Choose a driver'}
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--anchor-width) min-w-80 p-0">
          <Command
            // Search the label, make, model, group and every category it suits.
            filter={(v, search, keywords) =>
              [v, ...(keywords ?? [])].join(' ').toLowerCase().includes(search.trim().toLowerCase())
                ? 1
                : 0
            }
          >
            <CommandInput placeholder="Search make, model or type of device" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>
                <p>No driver matches “{query}”.</p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    setAsking(true);
                  }}
                >
                  Request a driver for it
                </Button>
              </CommandEmpty>
              {groups.map(([group, items]) => (
                <CommandGroup key={group} heading={GROUP_LABEL[group]}>
                  {items.map((e) => (
                    <CommandItem
                      key={e.value}
                      value={e.value}
                      keywords={[
                        e.label,
                        e.make,
                        e.model,
                        GROUP_LABEL[e.group],
                        ...e.categories.map(assetCategoryLabel),
                      ]}
                      data-checked={e.value === value}
                      onSelect={() => {
                        onChange(e.value);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">{e.label}</span>
                      {e.group === 'custom' && <Badge variant="secondary">Custom</Badge>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
            <div className="border-t p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  setAsking(true);
                }}
              >
                <PlusIcon />
                Can’t find it? Request a driver
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
      {asking && (
        <RequestDriverDialog
          category={category}
          deviceId={deviceId}
          initialQuery={query}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

const CATEGORY_CHOICES = [
  ...DeviceCategory.options
    .filter((c) => c !== 'video_destination')
    .map((c) => ({ value: c as string, label: assetCategoryLabel(c) })),
  ...ASSET_ONLY_CATEGORIES.map((c) => ({ value: c as string, label: assetCategoryLabel(c) })),
].sort((a, b) => a.label.localeCompare(b.label));

/** Ask Kestrel for a driver for a device that has none. Open to every plan. */
export function RequestDriverDialog({
  category,
  deviceId,
  initialQuery = '',
  onClose,
}: {
  category?: string;
  deviceId?: string;
  initialQuery?: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [make, setMake] = useState('');
  const [model, setModel] = useState(initialQuery);
  const [cat, setCat] = useState(category ?? 'network_device');
  const [need, setNeed] = useState<(typeof DRIVER_REQUEST_NEEDS)[number]>('monitor');
  const [protocol, setProtocol] = useState<(typeof DRIVER_REQUEST_PROTOCOLS)[number]>('unknown');
  const [docsUrl, setDocsUrl] = useState('');
  const [notes, setNotes] = useState('');
  const mine = useQuery(trpc.driver.requests.list.queryOptions({ orgId }));
  const create = useMutation(
    trpc.driver.requests.create.mutationOptions({
      onSuccess: async () => {
        toast.success('Requested. Kestrel support will be in touch and the driver will show up in your list.');
        await qc.invalidateQueries({ queryKey: trpc.driver.requests.list.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const valid = make.trim().length > 0 && model.trim().length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request a driver</DialogTitle>
          <DialogDescription>
            Tell us about the device and how it is controlled. Kestrel support builds the driver and it
            appears in your driver list, private to your organisation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Make">
              <Input value={make} onChange={(e) => setMake(e.target.value)} maxLength={60} placeholder="Ubiquiti" />
            </Field>
            <Field label="Model">
              <Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={60} placeholder="UniFi U6 Pro" />
            </Field>
          </div>
          <Field label="Type of device">
            <SimpleSelect value={cat} onValueChange={setCat} options={CATEGORY_CHOICES} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="What do you need?">
              <SimpleSelect
                value={need}
                onValueChange={(v) => setNeed(v)}
                options={[
                  { value: 'monitor', label: 'Monitoring only' },
                  { value: 'control', label: 'Monitoring and control' },
                ]}
              />
            </Field>
            <Field label="How is it reached?">
              <SimpleSelect
                value={protocol}
                onValueChange={(v) => setProtocol(v)}
                options={DRIVER_REQUEST_PROTOCOLS.map((p) => ({
                  value: p,
                  label: DRIVER_REQUEST_PROTOCOL_LABEL[p],
                }))}
              />
            </Field>
          </div>
          <Field label="Link to the control protocol or API documentation (optional)">
            <Input value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} maxLength={500} placeholder="https://" />
          </Field>
          <Field label="Anything else we should know (optional)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} />
          </Field>
          {(mine.data?.length ?? 0) > 0 && (
            <div className="space-y-1 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">Your requests</p>
              {mine.data!.slice(0, 5).map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">
                    {r.make} {r.model}
                  </span>
                  <Badge variant={r.status === 'built' ? 'default' : 'secondary'}>
                    {DRIVER_REQUEST_STATUS_LABEL[r.status as DriverRequestStatus] ?? r.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || create.isPending}
            onClick={() =>
              create.mutate({
                orgId,
                request: {
                  make: make.trim(),
                  model: model.trim(),
                  category: cat as never,
                  need,
                  protocol,
                  docsUrl: docsUrl.trim() || undefined,
                  notes: notes.trim(),
                  deviceId,
                },
              })
            }
          >
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
