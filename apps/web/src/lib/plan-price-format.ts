// How plan prices read on the billing page. Amounts arrive in the smallest currency unit (cents).

export type PriceTax = 'inclusive' | 'exclusive' | 'unspecified';

/** "$12.50" or "A$12", in the viewer's locale. Whole amounts drop the cents. */
export function formatMoney(amount: number, currency: string): string {
  const major = amount / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** What to say about tax. Kestrel never guesses: it repeats what Stripe's price says (BD-4). */
export function taxNote(tax: PriceTax): string {
  if (tax === 'inclusive') return 'includes tax';
  if (tax === 'exclusive') return 'excludes tax';
  return 'tax may be added at checkout';
}

/** The yearly price as a monthly figure, rounded to the nearest cent. */
export const perMonthFromYear = (yearly: number): number => Math.round(yearly / 12);
