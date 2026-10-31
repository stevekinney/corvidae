import { createHash } from 'node:crypto';

import { MemoryStorage } from '@lostgradient/storage';
import { z } from 'zod';

import type { PluginContributions } from '../contributions.ts';
import type { PluginHostApi } from '../host-api.ts';
import type { PluginDescriptor } from '../plugin-descriptor.ts';

/** One name a plugin's durable records, files or settings can refer to, with the shape it has. */
export interface PluginIdentityEntry {
  /** What the entry is: `configuration`, `tool`, `activity`, `trigger-kind` and the other kinds. */
  readonly kind: string;
  /** The identifier a file or record names it by: the plugin's name for `configuration`, otherwise `plugin:name`. */
  readonly id: string;
  /** The entry's own version, or the plugin's when it declares none. */
  readonly version: string;
  /** A digest of the entry's schema, or `null` for an entry that has none. */
  readonly schema: string | null;
}

/** The identity snapshot a plugin commits as `plugin-identities.json`. */
export interface PluginIdentities {
  /** The plugin's name. */
  readonly plugin: string;
  /** The plugin's version. */
  readonly version: string;
  /** Every identity the plugin holds, ordered by kind and then id. */
  readonly entries: readonly PluginIdentityEntry[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** A JSON Schema `required` list in order, since the order a schema lists its fields in is not part of its shape. */
function sortedStrings(value: unknown): unknown {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.toSorted(compareText)
    : value;
}

/** `value` as JSON with every object's keys in sorted order, so equal values serialize equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]): [string, unknown] => [
        key,
        key === 'required' ? sortedStrings(member) : member,
      ])
      .toSorted(([left], [right]) => compareText(left, right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isZodSchema(value: unknown): value is z.core.$ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/** The JSON Schema `schema` describes, or the value itself when it is already plain data. */
function describeSchema(schema: unknown): unknown {
  if (isZodSchema(schema)) {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  }
  return schema;
}

/**
 * A digest of a schema's shape: the `sha256:` hash of its canonical JSON Schema. A value that is
 * `undefined` has no schema and digests to `null`. Equal shapes digest equally wherever they were
 * built, and any change to the shape changes the digest.
 */
export function schemaDigest(schema: unknown): string | null {
  if (schema === undefined) return null;
  const hash = createHash('sha256')
    .update(canonicalJson(describeSchema(schema)))
    .digest('hex');
  return `sha256:${hash}`;
}

const unstartedMessage = 'The host has not started: a plugin may call it only after afterStart.';

/** A host API whose every call rejects, as the real one does before the host has started. */
const unstartedHost: PluginHostApi = {
  agents: {
    list: () => {
      throw new Error(unstartedMessage);
    },
  },
  schedules: {
    create: () => Promise.reject(new Error(unstartedMessage)),
    list: () => Promise.reject(new Error(unstartedMessage)),
  },
  goals: { create: () => Promise.reject(new Error(unstartedMessage)) },
};

/**
 * Runs a plugin's `setup` with an empty configuration, no secrets, memory storage and a host that
 * has not started, and returns what it contributes. A plugin whose configuration schema refuses
 * `{}` throws, because its identity cannot be read without a configuration.
 */
export async function pluginContributions(
  descriptor: PluginDescriptor<z.ZodType>,
): Promise<PluginContributions> {
  const parsed = (descriptor.configuration ?? z.object({})).safeParse({});
  if (!parsed.success) {
    throw new TypeError(
      `Plugin "${descriptor.name}" needs defaults for every configuration field: its configuration schema refuses {} (${parsed.error.message}).`,
    );
  }
  if (descriptor.setup === undefined) return {};
  return await descriptor.setup({
    configuration: parsed.data,
    secrets: { get: async () => undefined },
    storage: new MemoryStorage(),
    host: unstartedHost,
  });
}

interface Named {
  readonly name: string;
  readonly version?: string;
}

function entriesOf<TItem>(
  items: readonly TItem[] | undefined,
  entry: (item: TItem) => {
    kind: string;
    name: string;
    version?: string | undefined;
    schema: unknown;
  },
  plugin: PluginDescriptor<z.ZodType>,
): PluginIdentityEntry[] {
  return (items ?? []).map((item) => {
    const { kind, name, version, schema } = entry(item);
    return {
      kind,
      id: `${plugin.name}:${name}`,
      version: version ?? plugin.version,
      schema: schemaDigest(schema),
    };
  });
}

function named(item: Named, kind: string, schema?: unknown) {
  return { kind, name: item.name, version: item.version, schema };
}

/**
 * The identities a plugin holds: its configuration schema, and for every contribution that a
 * record, file or setting can name, its id, version and schema digest. A contribution that
 * declares no version of its own takes the plugin's. The entries are ordered, so equal plugins
 * produce equal snapshots. Guardrails, decision routers and memory detectors carry no name a
 * record or file can refer to, so they are not listed.
 */
export async function pluginIdentities(
  descriptor: PluginDescriptor<z.ZodType>,
): Promise<PluginIdentities> {
  const contributions = await pluginContributions(descriptor);
  const entries: PluginIdentityEntry[] = [
    {
      kind: 'configuration',
      id: descriptor.name,
      version: descriptor.version,
      schema: schemaDigest(descriptor.configuration ?? z.object({})),
    },
    ...entriesOf(
      contributions.tools,
      (tool) => {
        const { identity, input, inputJsonSchema } = tool.configuration;
        return {
          kind: 'tool',
          name: identity.name,
          version: identity.version,
          schema: { input: describeSchema(input), inputJsonSchema },
        };
      },
      descriptor,
    ),
    ...entriesOf(
      contributions.activities,
      (activity) =>
        named(activity, 'activity', {
          input: describeSchema(activity.inputSchema),
          output: describeSchema(activity.outputSchema),
        }),
      descriptor,
    ),
    ...entriesOf(
      contributions.validators,
      (validator) => ({
        kind: 'validator',
        name: validator.identity.name,
        version: validator.identity.version,
        schema: undefined,
      }),
      descriptor,
    ),
    ...entriesOf(
      contributions.triggerKinds,
      (kind) => named(kind, 'trigger-kind', kind.configuration),
      descriptor,
    ),
    ...entriesOf(
      contributions.hookActionKinds,
      (kind) => named(kind, 'hook-action', kind.configuration),
      descriptor,
    ),
    ...entriesOf(
      contributions.embedders,
      (embedder) => named(embedder, 'embedder', { dimensions: embedder.dimensions }),
      descriptor,
    ),
    ...entriesOf(
      contributions.mcpApps,
      (app) => named(app, 'mcp-app', { allowedTools: app.allowedTools.toSorted(compareText) }),
      descriptor,
    ),
    ...entriesOf(contributions.evalJudges, (judge) => named(judge, 'eval-judge'), descriptor),
    ...entriesOf(contributions.providers, (provider) => named(provider, 'provider'), descriptor),
    ...entriesOf(contributions.runHooks, (hooks) => named(hooks, 'run-hooks'), descriptor),
    ...entriesOf(
      contributions.eventFormatters,
      (formatter) =>
        named(formatter, 'event-formatter', {
          eventKinds: [...formatter.eventKinds].toSorted(compareText),
        }),
      descriptor,
    ),
    ...entriesOf(contributions.codeAgents, (agent) => named(agent, 'code-agent'), descriptor),
  ];
  return {
    plugin: descriptor.name,
    version: descriptor.version,
    entries: entries.toSorted(
      (left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id),
    ),
  };
}
