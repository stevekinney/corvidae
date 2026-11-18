/**
 * The browser's view of the Bureau's runtime settings: `bureau.settings.get`, `.schema`, and
 * `.update` (COR-1710), parsed at the boundary. The settings are deployment-wide, one record with a
 * `revision`: a write names the revision it read (`expectedRevision`), and a record that changed
 * since is refused as a `StaleRevision` fault that carries the revision now current. A write is all
 * or none, so a refusal changes nothing.
 *
 * The Bureau answers a refused `update` as a fault: `StaleRevision` for a stale revision,
 * `Unprocessable` for a key the deployment locked, and `InvalidParams` for an unknown key or a value
 * the key does not take. {@link settingsFaultOf} sorts them for the page.
 */
import type { SettingLockReason } from '@lostgradient/bureau';
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { bureauClient, type BureauEvent, type BureauOutput } from './bureau-api.ts';
import { type Fetcher } from './bureau-client.ts';
import { acceptedFetch, eventsOf } from './bureau-subscriptions.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * Why a key is locked, as `bureau.settings.get` reports it. The browser cannot import the list
 * from Bureau, whose index is server code, so it is spelled here, and `satisfies` and the
 * exhaustiveness check below fail the type-check when Bureau's list and this one differ. A test
 * compares them as values too (`bureau-settings.test.ts`).
 */
export const SETTING_LOCK_REASONS = [
  'deployment',
  'shared-storage',
] as const satisfies readonly SettingLockReason[];

// Fails to compile when Bureau adds a reason this list lacks.
const lockReasonsAreExhaustive: SettingLockReason extends (typeof SETTING_LOCK_REASONS)[number]
  ? true
  : never = true;
void lockReasonsAreExhaustive;

/** How one key stands: how it applies, whether the deployment locked it, and whether a stored value waits for a restart. */
const keyStateSchema = z.object({
  apply: z.enum(['live', 'restart']),
  locked: z.boolean(),
  /** Why the key is locked; present exactly when `locked` is `true`. */
  lockReason: z.enum(SETTING_LOCK_REASONS).optional(),
  /** Why Bureau did not apply the key's stored value, such as a decision model that no longer exists. */
  problem: z.string().optional(),
  pendingRestart: z.boolean(),
});

const snapshotSchema = z.object({
  /** Each key's value, by dotted key. A key with no value is absent. */
  values: z.record(z.string(), z.unknown()),
  /**
   * Each key's value as it applies: its `values` entry, or where it has none, the value it applies
   * by when nothing sets it, shown as "Default: 7 days" on an unset row. A key whose unset state has
   * no one value (no model policy, no summarizer) is absent here too.
   */
  effective: z.record(z.string(), z.unknown()),
  /**
   * Each key's value as the host runs it now: a `restart` key's booted value, which a saved change
   * waits to replace. Revert writes it back (`null` where it is absent, which clears the stored
   * value). A key nothing set at boot is absent.
   */
  running: z.record(z.string(), z.unknown()),
  revision: z.number().int().nonnegative(),
  /** Whether the record outlives the process. */
  persisted: z.boolean(),
  keys: z.record(z.string(), keyStateSchema),
});

/** Every setting's value and state, and the revision a write is compared against. */
export type SettingsSnapshot = z.infer<typeof snapshotSchema>;

/** How one key stands, as `bureau.settings.get` reports it. */
export type SettingKeyState = z.infer<typeof keyStateSchema>;

/**
 * A JSON Schema (2020-12) node, with the keywords the settings schema uses. It is read by shape
 * (`settings-controls.ts`), so only what that reading needs is named, and a keyword it does not
 * name is kept and left alone.
 */
export type SchemaNode = {
  readonly type?: string | undefined;
  readonly const?: unknown;
  readonly enum?: readonly unknown[] | undefined;
  readonly anyOf?: readonly SchemaNode[] | undefined;
  readonly properties?: Readonly<Record<string, SchemaNode>> | undefined;
  readonly required?: readonly string[] | undefined;
  /** What an object's other properties hold; a record of strings is `{ type: 'string' }`. */
  readonly additionalProperties?: unknown;
  readonly description?: string | undefined;
  readonly pattern?: string | undefined;
  readonly minimum?: number | undefined;
  readonly exclusiveMinimum?: number | undefined;
  readonly maximum?: number | undefined;
};

// Loose: the keywords this file does not name (`items`, `additionalProperties`, `format`) are kept,
// because the settings page hands the whole node to a `SchemaForm`.
const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z.looseObject({
    type: z.string().optional(),
    const: z.unknown().optional(),
    enum: z.array(z.unknown()).optional(),
    anyOf: z.array(schemaNodeSchema).optional(),
    properties: z.record(z.string(), schemaNodeSchema).optional(),
    required: z.array(z.string()).optional(),
    description: z.string().optional(),
    pattern: z.string().optional(),
    minimum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
);

const schemaAnswerSchema = z.object({
  schema: z.object({ properties: z.record(z.string(), schemaNodeSchema) }),
});

/** The settings' schema: one entry per dotted key, in the schema's own order. */
export type SettingsSchema = Readonly<Record<string, SchemaNode>>;

/** Every setting's value and state (`bureau.settings.get`). */
export async function getSettings(options?: Options): Promise<SettingsSnapshot> {
  // The server's schema leaves each key's state untyped, so the page's own shape reads it here.
  return snapshotSchema.parse(await bureauClient['bureau.settings.get']({}, options));
}

/** The settings' keys and the shape of each (`bureau.settings.schema`). */
export async function getSettingsSchema(options?: Options): Promise<SettingsSchema> {
  // The server's schema calls the settings' schema a bare record; the nodes are read by shape here.
  return schemaAnswerSchema.parse(await bureauClient['bureau.settings.schema']({}, options)).schema
    .properties;
}

/** What an applied update answers: the record's revision after it, and the `restart` keys it set. */
export type SettingsUpdateReceipt = BureauOutput<'bureau.settings.update'>;

/**
 * Changes the keys in `patch`, all or none, against the revision the caller read. A refusal is
 * thrown as the fault the Bureau answered; {@link settingsFaultOf} says which.
 */
export async function updateSettings(
  patch: Readonly<Record<string, unknown>>,
  expectedRevision: number,
  options?: Options,
): Promise<SettingsUpdateReceipt> {
  return bureauClient['bureau.settings.update']({ patch, expectedRevision }, options);
}

/**
 * The refusals of an update the page tells apart.
 *
 * - `stale`: the record changed since the page read it. `currentRevision` is the revision now.
 * - `locked`: a patched key is one the deployment locked.
 * - `rejected`: a key is unknown or a value is not one the key takes. `message` names them.
 * - `forbidden`: the caller may not change the settings.
 * - `other`: anything else, such as a Bureau that did not answer.
 */
export type SettingsFault =
  | { readonly kind: 'stale'; readonly currentRevision: number | null }
  | { readonly kind: 'locked'; readonly message: string }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'other'; readonly message: string };

/** The issues an `InvalidParams` fault carries, as `key: message` joined by `; `, or `undefined` when it carries none. */
function issueSummaryOf(data: Record<string, unknown>): string | undefined {
  const issues = data['issues'];
  if (!Array.isArray(issues)) return undefined;
  const lines: string[] = [];
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') continue;
    // The path is `['patch', <key>]`: the key is what the person can act on.
    const segments = Array.isArray(path) ? (path as unknown[]).slice(1).map(String) : [];
    lines.push(segments.length === 0 ? message : `${segments.join('.')}: ${message}`);
  }
  return lines.length === 0 ? undefined : lines.join('; ');
}

/** Sorts a thrown fault into the {@link SettingsFault} the page shows. */
export function settingsFaultOf(error: unknown): SettingsFault {
  if (!(error instanceof HttpClientError)) {
    return {
      kind: 'other',
      message: error instanceof Error ? error.message : 'The server did not answer.',
    };
  }
  const data = error.data;
  switch (data?.['weftCode']) {
    case 'StaleRevision': {
      const current = data['currentRevision'];
      return { kind: 'stale', currentRevision: typeof current === 'number' ? current : null };
    }
    case 'Unprocessable':
      return data['reason'] === 'locked'
        ? { kind: 'locked', message: error.message }
        : { kind: 'rejected', message: error.message };
    case 'InvalidParams': {
      const summary = issueSummaryOf(data);
      return { kind: 'rejected', message: summary ?? error.message };
    }
    case 'Forbidden':
      return { kind: 'forbidden' };
    default:
      return { kind: 'other', message: error.message };
  }
}

/**
 * One change to the settings, as `bureau.settings.events` sends it: the new revision and the keys,
 * never a value. `cursor` is the change's revision as a cursor, which a stream opened with it in
 * `Last-Event-ID` carries on from; `keys` are the keys the change set (a resumed stream's first
 * event names none).
 */
export type SettingsChange = BureauEvent<'bureau.settings.events'>;

/**
 * Reads what the stream sent as a change, or `undefined` for data that is not one, which the
 * follower skips.
 */
function readSettingsChange(data: unknown): SettingsChange | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (Reflect.get(data, 'kind') !== 'settings.changed') return undefined;
  if (typeof Reflect.get(data, 'cursor') !== 'string') return undefined;
  if (typeof Reflect.get(data, 'revision') !== 'number') return undefined;
  // The kind, the cursor and the revision are read; the rest is what the subscription's event type says.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return data as SettingsChange;
}

/**
 * Opens the settings stream from `cursor` (or from now, when there is none) and yields each change
 * as the Bureau sends it. The cursor goes in `Last-Event-ID`, which is how the Bureau resumes a
 * stream: a stream resumed behind the current revision opens with one event for the current one. A
 * refusal throws the `HttpClientError` the response's status makes, a stream that ends ends this
 * generator, and data that is not a change is skipped: heartbeats are frames too.
 */
export async function* followSettingsEvents(options: {
  readonly cursor?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
  /** Called once the Bureau has accepted the subscription, before any event arrives. */
  readonly onOpen?: () => void;
}): AsyncGenerator<SettingsChange, void, void> {
  const messages = bureauClient['bureau.settings.events'](
    {},
    {
      fetch: acceptedFetch(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cursor === undefined ? {} : { lastEventId: options.cursor }),
    },
  );
  for await (const { data } of eventsOf(messages, 'settings stream')) {
    const change = readSettingsChange(data);
    if (change !== undefined) yield change;
  }
}
