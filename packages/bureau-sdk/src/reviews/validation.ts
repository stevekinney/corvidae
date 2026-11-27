import type { CatalogTransport } from '@lostgradient/backchannel/client';
import type { ReviewsOperationTypes } from '../generated/reviews-operations.generated.ts';
import { reviewsOutputSchemas } from '../generated/reviews-output-schemas.generated.ts';

type ListedReview = ReviewsOperationTypes['bureau.reviews.list']['output']['reviews'][number];
type ToolReview = Extract<ListedReview, { kind: 'tool-approval' }>;
export type ReviewsOpeningSnapshot = {
  readonly reviews: ReadonlyArray<
    Exclude<ListedReview, ToolReview> | (Omit<ToolReview, 'round'> & { readonly round?: number })
  >;
  readonly actionable: false;
};

type Schema = {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly propertyNames?: Schema;
  readonly items?: Schema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly minLength?: number;
};

function matches(schema: Schema, value: unknown): boolean {
  if (schema.oneOf && schema.oneOf.filter((branch) => matches(branch, value)).length !== 1)
    return false;
  if (schema.anyOf && !schema.anyOf.some((branch) => matches(branch, value))) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string')
    return (
      typeof value === 'string' &&
      (schema.minLength === undefined || Array.from(value).length >= schema.minLength)
    );
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum) &&
      (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum)
    );
  if (schema.type === 'array')
    return (
      Array.isArray(value) && (!schema.items || value.every((item) => matches(schema.items!, item)))
    );
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some((key) => !Object.hasOwn(object, key) || object[key] === undefined))
      return false;
    for (const key of Object.keys(object)) {
      if (schema.propertyNames && !matches(schema.propertyNames, key)) return false;
      const property =
        schema.properties && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      if (property) {
        if (!matches(property, object[key])) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (
        typeof schema.additionalProperties === 'object' &&
        !matches(schema.additionalProperties, object[key])
      )
        return false;
    }
  }
  return true;
}

const schemas: Readonly<Record<string, Schema>> = reviewsOutputSchemas;

/** Omit effects the portable contract does not understand before exposing a review to a caller. */
function publicReview(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (source['kind'] !== 'tool-approval' || !Object.hasOwn(source, 'effect')) return value;
  const effect = source['effect'];
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return value;
  const kind = (effect as Record<string, unknown>)['kind'];
  const known = schemas['bureau.reviews.get']?.oneOf?.find(
    (branch) => branch.properties?.['kind']?.const === 'tool-approval',
  )?.properties?.['effect']?.properties?.['kind']?.const;
  if (typeof kind !== 'string' || kind.length === 0 || kind === known) return value;
  const copy = { ...source };
  delete copy['effect'];
  return copy;
}

function withoutUnknownEffects(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source['reviews'])) return publicReview(value);
  return { ...source, reviews: source['reviews'].map(publicReview) };
}

/** Validate the declared Reviews outputs without changing the caller's transport or input. */
export function validatedReviewsTransport(transport: CatalogTransport): CatalogTransport {
  return async (name, input, options) => {
    return parseReviewsOutput(name, await transport(name, input, options));
  };
}

/** Validate and sanitize a Reviews response before rendering or placing it in a cache. */
export function parseReviewsOutput(name: string, input: unknown): unknown {
  if (!Object.hasOwn(schemas, name) || name === 'opening')
    throw new TypeError(`Unsupported Reviews operation: ${name}`);
  const value = withoutUnknownEffects(input);
  if (!matches(schemas[name]!, value)) throw new TypeError(`Invalid ${name} response`);
  return value;
}

// Opening data is not correlated with a caller. Its schema differs only in permitting a missing
// approval round and omitting the list's paging metadata; it never creates an actionable target.

/** Parse uncorrelated panel opening data as display-only; no authority is inferred. */
export function parseReviewsOpeningSnapshot(value: unknown): ReviewsOpeningSnapshot | undefined {
  value = withoutUnknownEffects(value);
  if (!matches(schemas['opening']!, value)) return undefined;
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
  if (!matches(schemas['opening']!, copy)) return undefined;
  const reviews = (copy as { reviews: ReviewsOpeningSnapshot['reviews'] }).reviews;
  if (reviews.some((review) => review.id.length === 0)) return undefined;
  return { reviews, actionable: false };
}
