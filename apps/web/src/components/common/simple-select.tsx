'use client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

// Thin wrapper over the Base UI select so callers pass plain options and get a string back.
export function SimpleSelect<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  size,
  id,
  disabled,
}: {
  value: T | '';
  onValueChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'default';
  id?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      items={options}
      value={value === '' ? null : value}
      onValueChange={(v) => v !== null && onValueChange(v as T)}
      disabled={disabled}
    >
      <SelectTrigger id={id} size={size} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
