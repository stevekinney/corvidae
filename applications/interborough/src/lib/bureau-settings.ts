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
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** How one key stands: how it applies, whether the deployment locked it, and whether a stored value waits for a restart. */
const keyStateSchema = z.object({
  apply: z.enum(['live', 'restart']),
  locked: z.boolean(),
  pendingRestart: z.boolean(),
});

const snapshotSchema = z.object({
  /** Each key's value, by dotted key. A key with no value is absent. */
  values: z.record(z.string(), z.unknown()),
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
 * name is left alone.
 */
export type SchemaNode = {
  readonly type?: string | undefined;
  readonly const?: unknown;
  readonly enum?: readonly unknown[] | undefined;
  readonly anyOf?: readonly SchemaNode[] | undefined;
  readonly properties?: Readonly<Record<string, SchemaNode>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly pattern?: string | undefined;
  readonly minimum?: number | undefined;
  readonly exclusiveMinimum?: number | undefined;
  readonly maximum?: number | undefined;
};

const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z.object({
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
  return snapshotSchema.parse(await callBureau('bureau.settings.get', {}, options));
}

/** The settings' keys and the shape of each (`bureau.settings.schema`). */
export async function getSettingsSchema(options?: Options): Promise<SettingsSchema> {
  return schemaAnswerSchema.parse(await callBureau('bureau.settings.schema', {}, options)).schema
    .properties;
}

const updateAnswerSchema = z.object({
  revision: z.number().int().nonnegative(),
  pendingRestart: z.array(z.string()),
});

/** What an applied update answers: the record's revision after it, and the `restart` keys it set. */
export type SettingsUpdateReceipt = z.infer<typeof updateAnswerSchema>;

/**
 * Changes the keys in `patch`, all or none, against the revision the caller read. A refusal is
 * thrown as the fault the Bureau answered; {@link settingsFaultOf} says which.
 */
export async function updateSettings(
  patch: Readonly<Record<string, unknown>>,
  expectedRevision: number,
  options?: Options,
): Promise<SettingsUpdateReceipt> {
  return updateAnswerSchema.parse(
    await callBureau('bureau.settings.update', { patch, expectedRevision }, options),
  );
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
      message: error instanceof Error ? error.message : 'The Bureau did not answer.',
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
