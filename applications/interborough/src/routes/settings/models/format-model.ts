/** How the Models page words a provider, and a model's size and price. */
import { ALLOWED_MODELS_COPY, MODELS_COPY } from '../../../app/copy.ts';

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

/** What a provider's models are called ("Claude models"), or `undefined` for one the page has no words for. */
export function providerTagline(provider: string): string | undefined {
  return Object.hasOwn(MODELS_COPY.providerTaglines, provider)
    ? MODELS_COPY.providerTaglines[provider]
    : undefined;
}

/**
 * The providers in the order the page lists them: Anthropic, OpenAI and Gemini, then any other the
 * host offers in the order it reported it. The host's own order is not relied on.
 */
export function providersInOrder<Provider extends { readonly name: string }>(
  providers: readonly Provider[],
): Provider[] {
  const rank = (provider: Provider): number => {
    const position = MODELS_COPY.providerOrder.indexOf(provider.name);
    return position === -1 ? MODELS_COPY.providerOrder.length : position;
  };
  return providers
    .map((provider, index) => ({ provider, index }))
    .toSorted((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map(({ provider }) => provider);
}

/** A provider's own name for a model family that is spelled in capitals, such as `gpt`. */
const ACRONYMS: ReadonlySet<string> = new Set(['gpt']);

/**
 * A model's name as a person says it, from the identifier the catalog lists: `claude-sonnet-5-5`
 * reads "Claude Sonnet 5.5". Words are capitalized, a version split across hyphens is joined with a
 * point, and a part that is neither a word nor a short number (a date, `4o`) is left as it is.
 */
export function modelDisplayName(model: string): string {
  const parts: string[] = [];
  for (const part of model.split('-')) {
    const previous = parts.at(-1);
    if (
      /^\d{1,3}$/.test(part) &&
      previous !== undefined &&
      /^\d{1,3}(\.\d{1,3})*$/.test(previous)
    ) {
      parts[parts.length - 1] = `${previous}.${part}`;
    } else if (ACRONYMS.has(part)) {
      parts.push(part.toUpperCase());
    } else if (/^[a-z]+$/.test(part)) {
      parts.push(`${part.slice(0, 1).toUpperCase()}${part.slice(1)}`);
    } else {
      parts.push(part);
    }
  }
  return parts.join(' ');
}

/**
 * What a model can do, in a few words for a list of models: "Tools · images", or "Text only" for a
 * model that does neither. Only the abilities an agent chooses a model for are named.
 */
export function formatModelAbilities(model: {
  readonly tools: boolean;
  readonly images: boolean;
}): string {
  const words = ALLOWED_MODELS_COPY.models.abilities;
  const named = [...(model.tools ? [words.tools] : []), ...(model.images ? [words.images] : [])];
  if (named.length === 0) return ALLOWED_MODELS_COPY.models.noAbilities;
  const text = named.join(' · ');
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}
