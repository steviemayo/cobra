'use client';
import { useRef } from 'react';
import { cn } from '@/lib/utils';

interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
}

/** One box per digit. Typing moves on, backspace moves back, pasting fills every box. */
export function CodeInput({
  value,
  onChange,
  length = 6,
  disabled,
  autoFocus,
  label = 'Code',
}: CodeInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const setAt = (i: number, digits: string) => {
    const chars = value.padEnd(length, ' ').split('');
    const incoming = digits.slice(0, length - i).split('');
    incoming.forEach((d, k) => (chars[i + k] = d));
    onChange(chars.join('').replace(/ /g, '').slice(0, length));
    focus(i + incoming.length);
  };

  return (
    <div role="group" aria-label={label} className="flex gap-2">
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          aria-label={`${label} digit ${i + 1}`}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          maxLength={length}
          value={value[i] ?? ''}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '');
            if (digits) setAt(i, digits);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              if (value[i]) onChange(value.slice(0, i) + value.slice(i + 1));
              else if (i > 0) {
                onChange(value.slice(0, i - 1) + value.slice(i));
                focus(i - 1);
              }
            } else if (e.key === 'ArrowLeft') focus(i - 1);
            else if (e.key === 'ArrowRight') focus(i + 1);
          }}
          className={cn(
            'size-11 rounded-md border border-input bg-background text-center text-lg font-medium',
            'outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50',
            'disabled:opacity-50',
          )}
        />
      ))}
    </div>
  );
}
