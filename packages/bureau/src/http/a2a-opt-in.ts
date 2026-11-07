/**
 * Which agents answer over A2A, once the `a2a.agents` setting is taken into account (COR-2019).
 *
 * An agent opts in by its own definition: a persisted agent's file says `a2a: true`, and a
 * code-defined agent is named in `createBureauHandler`'s `a2aAgents`. The `a2a.agents` setting is a
 * record of agent names to booleans that overrides that definition for the agents it names, so a
 * person can share or withdraw any agent from Settings, a code-defined one included. An agent the
 * record leaves out follows its own definition, exactly as it did before the setting existed.
 *
 * The setting is `live`: the record is read again on every change, so an agent shared or
 * withdrawn is served or refused on the next request without a restart. The overrides are held in
 * memory and refreshed from `bureau.settings.subscribe`, because the opt-in is asked for
 * synchronously; {@link A2AOptInOverrides.ready} settles once the first read has, and the A2A
 * mount waits on it, so a request that arrives right after a start never sees the definitions
 * alone.
 *
 * @module a2a-opt-in
 */

import type { BureauSettings } from '../settings/types.ts';

/** The record the `a2a.agents` setting holds, as the overrides read it. */
export type A2AOptInOverrides = {
  /**
   * What the setting says about `agentName`: `true` shares it, `false` withdraws it, and
   * `undefined` leaves it to its own definition.
   */
  readonly of: (agentName: string) => boolean | undefined;
  /** Settles once the stored record has been read. Never rejects. */
  readonly ready: Promise<void>;
};

const held = new WeakMap<object, A2AOptInOverrides>();

function recordOf(value: unknown): ReadonlyMap<string, boolean> {
  const record = new Map<string, boolean>();
  if (typeof value !== 'object' || value === null) return record;
  for (const [name, shared] of Object.entries(value)) {
    if (typeof shared === 'boolean') record.set(name, shared);
  }
  return record;
}

/**
 * The overrides of `settings`, read and followed once per settings object, however many parts of
 * the handler ask. A Bureau without readable settings has none, so every agent follows its own
 * definition.
 */
export function a2aOptInOverridesOf(
  settings: Pick<BureauSettings, 'get' | 'subscribe'> | undefined,
): A2AOptInOverrides {
  if (settings === undefined) return { of: () => undefined, ready: Promise.resolve() };
  const existing = held.get(settings);
  if (existing !== undefined) return existing;
  let current: ReadonlyMap<string, boolean> = new Map();
  // A read that finishes after a later one began is stale, so only the newest read is kept.
  let newest = 0;
  const read = async (): Promise<void> => {
    newest += 1;
    const mine = newest;
    const snapshot = await settings.get();
    if (mine === newest) current = recordOf(snapshot.values['a2a.agents']);
  };
  settings.subscribe((change) => {
    if (change.keys.includes('a2a.agents')) void read().catch(() => undefined);
  });
  const overrides: A2AOptInOverrides = {
    of: (agentName) => current.get(agentName),
    ready: read().catch(() => undefined),
  };
  held.set(settings, overrides);
  return overrides;
}

/** Whether `agentName` answers over A2A: the setting's word for it, else `definition`'s. */
export function isOptedIntoA2A(
  overrides: A2AOptInOverrides,
  agentName: string,
  definition: boolean,
): boolean {
  return overrides.of(agentName) ?? definition;
}
