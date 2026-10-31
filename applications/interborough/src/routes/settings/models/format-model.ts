/** How the Models table words a model's size and price. */

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** A context window in short form: `200K`, `1M`. */
export function formatContext(tokens: number): string {
  return COMPACT.format(tokens);
}

/**
 * A price per million tokens in its currency. A currency code the platform does not know is printed
 * as the number followed by the code.
 */
export function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${String(amount)} ${currency}`;
  }
}
