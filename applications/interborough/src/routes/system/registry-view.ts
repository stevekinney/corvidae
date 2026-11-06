/**
 * The wire shapes of the registry snapshot (`weft.system.registry`, `@lostgradient/weft`'s
 * `RegistrySnapshot`, v2) as the contract checks and the codegen preview read them, and the two
 * helpers that summarise a JSON Schema fragment (`schemaTypeLabel`, `extractSchemaFields`). The
 * shapes mirror the package's structurally, so this module has no runtime dependency on it. A
 * schema fragment this module cannot structurally read renders as "unknown" rather than a
 * fabricated narrow type.
 */
import type { Duration, RetryPolicy } from '@lostgradient/weft';
import { compareCodepoint } from '../../lib/compare-codepoint.ts';

/** One signal, update, or query contract's schema pair. Mirrors `WorkflowMessageContract` (`@lostgradient/weft`) structurally. */
export interface WorkflowMessageContractSource {
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

/** One activity or finalizer contract's schema pair. Mirrors `WorkflowActivityContract` (`@lostgradient/weft`) structurally — currently identical to {@link WorkflowMessageContractSource}, kept as a distinct alias since the two vocabularies (message vs. activity) are independent on the wire and may diverge. */
export type WorkflowActivityContractSource = WorkflowMessageContractSource;

/** The subset of a `WorkflowRevisionManifest.contract` this module reads. Mirrors `WorkflowContract` (`@lostgradient/weft`) structurally rather than importing it, so this module has no runtime dependency on the package. */
export interface WorkflowContractSource {
  readonly name: string;
  readonly workflowVersion: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly signals?: Readonly<Record<string, WorkflowMessageContractSource>>;
  readonly updates?: Readonly<Record<string, WorkflowMessageContractSource>>;
  readonly queries?: Readonly<Record<string, WorkflowMessageContractSource>>;
  readonly activities?: Readonly<Record<string, WorkflowActivityContractSource>>;
  readonly finalizer?: WorkflowActivityContractSource;
}

/** Mirrors `WorkflowRevisionManifest` (`@lostgradient/weft`) structurally. */
export interface WorkflowRevisionManifestSource {
  readonly manifestVersion: number;
  readonly name: string;
  readonly workflowVersion: string;
  readonly revision: string;
  readonly contractHash: string;
  readonly contract: WorkflowContractSource;
}

/** Mirrors `RegistryActivityEntry` (`@lostgradient/weft`) structurally. `retry`/`timeout` types are imported `import type` only — erased at build time, zero bundle cost (see this module's own doc and `../../lib/faults.ts`'s identical constraint on runtime-safe imports). */
export interface RegistryActivityEntrySource {
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly queue: string;
  readonly description?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: Duration;
}

/** Mirrors `RegistrySnapshot` (`@lostgradient/weft`, v2) structurally. */
export interface RegistrySnapshotSource {
  readonly registryVersion: number;
  readonly generatedAt?: string;
  readonly workflows: readonly WorkflowRevisionManifestSource[];
  readonly activeRevisions: Readonly<Record<string, string>>;
  readonly activities: Readonly<Record<string, RegistryActivityEntrySource>>;
}

/** One field extracted from a JSON Schema `properties` map, for the Tree/list rendering. */
export interface RegistrySchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string | undefined;
}

function isJsonSchemaTypeString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Best-effort "type" label for one JSON Schema property fragment — a
 * compact summary, not a full schema renderer. Also used at the schema
 * ROOT (not just for a `properties` entry): a declared root schema that
 * isn't `type: 'object'` — a bare `{ type: 'string' }` input/output/
 * message schema, which Weft permits — has no `properties` to walk, so
 * {@link extractSchemaFields} legitimately returns `[]` for it. That empty
 * list must never be read as "no schema declared" when a schema WAS
 * declared; callers pair an empty list with this root-type label so a view
 * can say what the schema actually is.
 */
export function schemaTypeLabel(fragment: unknown): string {
  if (!isRecord(fragment)) return 'unknown';
  const record = fragment;

  if (Array.isArray(record['enum'])) return 'enum';
  if (isJsonSchemaTypeString(record['type'])) return record['type'];
  if (Array.isArray(record['type']) && record['type'].every(isJsonSchemaTypeString)) {
    return record['type'].join(' | ');
  }
  if (record['anyOf'] !== undefined || record['oneOf'] !== undefined) return 'union';
  return 'unknown';
}

function schemaDescription(fragment: unknown): string | undefined {
  if (!isRecord(fragment)) return undefined;
  const description = fragment['description'];
  return typeof description === 'string' ? description : undefined;
}

/**
 * Extracts a flat field list from a top-level JSON Schema `object` fragment's
 * `properties`/`required`. Non-object schemas (a bare string/number input
 * schema) yield an empty list rather than throwing — the Tree view falls
 * back to a "no fields" note in that case.
 */
export function extractSchemaFields(
  schema: Record<string, unknown> | undefined,
): readonly RegistrySchemaField[] {
  if (!schema) return [];
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null) return [];

  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  if (!isRecord(properties)) return [];
  return Object.entries(properties)
    .map(([name, fragment]): RegistrySchemaField => ({
      name,
      type: schemaTypeLabel(fragment),
      required: required.has(name),
      description: schemaDescription(fragment),
    }))
    .toSorted((a, b) => compareCodepoint(a.name, b.name));
}
