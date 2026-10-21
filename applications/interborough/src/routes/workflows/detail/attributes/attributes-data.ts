/**
 * The run's search attributes (COR-1461): `weft.workflows.attributes.get` and `.set`, called through
 * `client.operations[...]` because neither has an ergonomic `HttpClient` method.
 *
 * ## What the console can know about a value's type
 *
 * `get` answers JSON, and JSON has no date: an attribute the workflow declares `date-time` arrives
 * as the ISO string `Date#toISOString` writes. The console reads no attribute schema (no operation
 * serves one), so it calls a string a date when it has exactly that shape, which a `date-time`
 * attribute always has and a plain string attribute rarely does. The guess only chooses the editor:
 * `set` converts an ISO string to a `Date` only where the schema declares `date-time`
 * (`set-workflow-attributes.ts`), so a plain string that looks like a date is stored as the string
 * it was.
 *
 * ## Editing changes existing values only
 *
 * The console edits the value of a key the run already has, in the type it has. It adds no key and
 * removes none, and it never edits an engine-owned key (`weft:` prefix), which the engine rewrites.
 */
import { HttpClientError, type HttpClient } from '@lostgradient/weft';

export const ATTRIBUTES_GET_OPERATION = 'weft.workflows.attributes.get';
export const ATTRIBUTES_SET_OPERATION = 'weft.workflows.attributes.set';

export type AttributesClient = {
  readonly operations: Pick<
    HttpClient['operations'],
    typeof ATTRIBUTES_GET_OPERATION | typeof ATTRIBUTES_SET_OPERATION
  >;
};

export function attributesQueryKey(workflowId: string): readonly unknown[] {
  return ['workflows', 'attributes', workflowId];
}

/** The types an attribute edit keeps: what a search attribute can hold, with the date told apart from a string. */
export type AttributeKind = 'string' | 'number' | 'boolean' | 'date' | 'list';

/** What `set` takes for one attribute: dates travel as ISO strings. */
export type AttributeValue = string | number | boolean | readonly string[];

export interface AttributeEntry {
  readonly key: string;
  readonly kind: AttributeKind;
  readonly value: AttributeValue;
  /** An engine-owned key (`weft:` prefix): shown, never edited. */
  readonly engineOwned: boolean;
}

export type AttributesReading =
  | { readonly kind: 'empty' }
  | { readonly kind: 'present'; readonly entries: readonly AttributeEntry[] };

/** `Date#toISOString`'s shape: UTC, with milliseconds. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isEngineOwnedKey(key: string): boolean {
  return key.startsWith('weft:');
}

export function isIsoDateTime(value: string): boolean {
  return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

/** A value `get` returned, in the kind the console edits it as. */
export type ClassifiedAttribute =
  | { readonly kind: 'string' | 'date'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'list'; readonly value: readonly string[] };

/** The kind of a value `get` returned, with the value narrowed to it, or `null` for one a search attribute cannot hold. */
export function classifyAttribute(value: unknown): ClassifiedAttribute | null {
  if (typeof value === 'string') return { kind: isIsoDateTime(value) ? 'date' : 'string', value };
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
    return { kind: 'list', value };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A run with no attribute record answers `NotFound`: that is an empty section, not a fault. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof HttpClientError && (error.status === 404 || error.faultCode === 'NotFound')
  );
}

/**
 * Read the run's attributes. A run with no attribute record (`NotFound`, or the `null` a REST 404
 * resolves to) reads as empty; any other fault is thrown. A value no search attribute can hold is
 * dropped rather than shown as something it is not.
 */
export async function readAttributes(
  client: AttributesClient,
  workflowId: string,
): Promise<AttributesReading> {
  let answer: unknown;
  try {
    answer = await client.operations[ATTRIBUTES_GET_OPERATION]({ workflowId });
  } catch (error) {
    if (isNotFound(error)) return { kind: 'empty' };
    throw error;
  }
  if (answer === null || answer === undefined) return { kind: 'empty' };
  if (!isRecord(answer)) {
    throw new TypeError(`${ATTRIBUTES_GET_OPERATION} returned an unexpected shape`);
  }

  const entries: AttributeEntry[] = [];
  for (const [key, value] of Object.entries(answer)) {
    const classified = classifyAttribute(value);
    if (classified === null) continue;
    entries.push({ key, ...classified, engineOwned: isEngineOwnedKey(key) });
  }
  entries.sort((left, right) => left.key.localeCompare(right.key));
  return entries.length === 0 ? { kind: 'empty' } : { kind: 'present', entries };
}

/** Set one existing key's value. Only that key travels: `set` merges, so the others stay as they are. */
export async function setAttribute(
  client: AttributesClient,
  workflowId: string,
  key: string,
  value: AttributeValue,
): Promise<void> {
  await client.operations[ATTRIBUTES_SET_OPERATION]({
    workflowId,
    attributes: { [key]: value },
  });
}

/**
 * Turn what an editor holds into the value to send, or a reason it cannot be: a number must be
 * finite, a date must parse. Strings, booleans and lists always can.
 */
export function parseEditedValue(
  kind: AttributeKind,
  draft: string | boolean | readonly string[],
):
  | { readonly ok: true; readonly value: AttributeValue }
  | { readonly ok: false; readonly reason: 'number' | 'date' } {
  switch (kind) {
    case 'number': {
      const parsed = typeof draft === 'string' && draft.trim() !== '' ? Number(draft) : Number.NaN;
      return Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, reason: 'number' };
    }
    case 'date': {
      const parsed = typeof draft === 'string' ? new Date(draft.trim()) : new Date(Number.NaN);
      return Number.isNaN(parsed.getTime())
        ? { ok: false, reason: 'date' }
        : { ok: true, value: parsed.toISOString() };
    }
    case 'boolean':
      return { ok: true, value: draft === true };
    case 'list':
      return { ok: true, value: Array.isArray(draft) ? [...(draft as readonly string[])] : [] };
    case 'string':
      return { ok: true, value: typeof draft === 'string' ? draft : '' };
  }
}
