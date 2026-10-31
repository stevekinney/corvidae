/** How the Models page words a provider, and a model's size and price. */
import { MODELS_COPY } from '../../../app/copy.ts';

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

/**
 * The name a person knows a provider by. The provider's name arrives from the host, so it is looked
 * up as an own key only: a name such as `constructor` is printed as it is, not as what every object
 * inherits.
 */
export function providerDisplayName(provider: string): string {
  return Object.hasOwn(MODELS_COPY.providerNames, provider)
    ? (MODELS_COPY.providerNames[provider] ?? provider)
    : provider;
}
