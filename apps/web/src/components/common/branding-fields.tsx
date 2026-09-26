'use client';
import { languageOptions } from '@kestrel/panel-ui';
import type { PanelBranding } from '@kestrel/model';
import { accentAdjustments } from '@/lib/accent';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleSelect } from './simple-select';

export interface BrandingDraft {
  mode: 'dark' | 'light';
  accent: string;
  logo: string;
  language: string;
}

export const brandingToDraft = (b: PanelBranding): BrandingDraft => ({
  mode: b.mode,
  accent: b.accent ?? '',
  logo: b.logoUrl ?? '',
  language: b.language,
});

export const draftToBranding = (d: BrandingDraft): PanelBranding => ({
  mode: d.mode,
  language: d.language,
  ...(d.accent.trim() && { accent: d.accent.trim() }),
  ...(d.logo.trim() && { logoUrl: d.logo.trim() }),
});

/** Theme, accent colour, logo and language: the look of a room panel. */
export function BrandingFields({
  value,
  onChange,
  disabled,
  id,
}: {
  value: BrandingDraft;
  onChange: (v: BrandingDraft) => void;
  disabled?: boolean;
  id: string;
}) {
  const set = (patch: Partial<BrandingDraft>) => onChange({ ...value, ...patch });
  const adjusted = accentAdjustments(value.accent);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${id}-theme`}>Theme</Label>
        <SimpleSelect
          id={`${id}-theme`}
          className="w-full"
          disabled={disabled}
          value={value.mode}
          onValueChange={(mode) => set({ mode })}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-language`}>Language</Label>
        <SimpleSelect
          id={`${id}-language`}
          className="w-full"
          disabled={disabled}
          value={value.language.split(/[-_]/)[0]!}
          onValueChange={(language) => set({ language })}
          options={languageOptions().map((l) => ({ value: l.code, label: l.label }))}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-accent`}>Accent colour</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-accent`}
            disabled={disabled}
            placeholder="#0f8a8c"
            pattern="^#[0-9a-fA-F]{3,8}$"
            value={value.accent}
            onChange={(e) => set({ accent: e.target.value })}
          />
          <span
            aria-hidden
            className="size-8 shrink-0 rounded-md border"
            style={{
              background: /^#[0-9a-fA-F]{3,8}$/.test(value.accent) ? value.accent : 'transparent',
            }}
          />
        </div>
        {adjusted?.changed && (
          <p className="text-xs text-warning">
            Adjusted so text stays readable: {adjusted.light.accent} in the light theme,{' '}
            {adjusted.dark.accent} in the dark theme.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Also colours buttons and highlights in the portal.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-logo`}>Logo address</Label>
        <Input
          id={`${id}-logo`}
          type="url"
          disabled={disabled}
          placeholder="https://…/logo.svg"
          value={value.logo}
          onChange={(e) => set({ logo: e.target.value })}
        />
      </div>
    </div>
  );
}
