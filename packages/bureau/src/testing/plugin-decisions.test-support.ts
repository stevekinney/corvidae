/**
 * COR-2204 — a Bureau that loads one plugin whose `setup` and `start` keep the host they are given,
 * with the `decision.made` events and audit records it produces. Every decision model is a double.
 */
import {
  definePlugin,
  type PluginHost,
  type PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';

import type { AgentDefinitions } from '../agent-catalog.ts';
import type { Bureau } from '../bureau-types/facade.ts';
import { createBureau } from '../create-bureau.ts';
import type { DecisionMadeEvent } from '../events.ts';
import type { BureauPluginSecrets } from '../plugins/plugin-types.ts';

/** What {@link openPluginBureau} loads. */
export interface PluginBureauOptions {
  /** The plugin's name. Defaults to `demo`. */
  readonly name?: string;
  /** Declares one secret, which `pluginSecrets` must supply for the plugin to run. */
  readonly secret?: string;
  readonly pluginSecrets?: BureauPluginSecrets;
  /** `false` loads the plugin disabled, so its `setup` runs once with a host that never starts. */
  readonly enabled?: boolean;
  /**
   * What the plugin contributes, built from the host its `setup` was given. That host is the one a
   * helper such as `decisionScorer` holds, so it is the late host until the Bureau binds it.
   */
  readonly contributions?: (host: PluginHost) => Omit<PluginSetupResult, 'start'>;
  /** Runs inside `setup`, before any host is bound, with the setup-time host. */
  readonly duringSetup?: (host: PluginHost) => void;
  /** More `createBureau` options: the agents, the decision models, the scorers. */
  readonly bureau?: Record<string, unknown>;
}

/** A Bureau with one plugin loaded, and what it observed. */
export interface PluginBureau {
  readonly bureau: Bureau<AgentDefinitions>;
  /** The host `setup` was given: the late host, which forwards once the Bureau binds it. */
  readonly setupHost: () => PluginHost;
  /** The host `start` was given. */
  readonly startHost: () => PluginHost;
  /** Every `decision.made` event the Bureau dispatched, in order. */
  readonly events: DecisionMadeEvent[];
  /** Every `decision.made` audit record on the trail. */
  readonly records: () => Promise<
    readonly {
      readonly runId: string;
      readonly principal?: string | undefined;
      readonly detail: Readonly<Record<string, unknown>>;
    }[]
  >;
}

const bureaus: Bureau<AgentDefinitions>[] = [];

/** Disposes every Bureau a test opened; call it from `afterEach`. */
export async function disposePluginBureaus(): Promise<void> {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
}

/** Loads the plugin and waits until its `start` has run. */
export async function openPluginBureau(options: PluginBureauOptions = {}): Promise<PluginBureau> {
  const { name = 'demo', secret, pluginSecrets, enabled, contributions, duringSetup } = options;
  let setupHost: PluginHost | undefined;
  let startHost: PluginHost | undefined;
  const descriptor = definePlugin({
    name,
    version: '1.0.0',
    description: 'Asks decisions.',
    ...(secret === undefined ? {} : { secrets: [secret] }),
    ...(enabled === undefined ? {} : { enabled }),
    setup: ({ host }) => {
      setupHost = host;
      duringSetup?.(host);
      return {
        ...contributions?.(host),
        start: (hostAtStart: PluginHost) => {
          startHost = hostAtStart;
        },
      };
    },
  });
  const bureau = await createBureau<AgentDefinitions>({
    storage: new MemoryStorage(),
    durable: false,
    plugins: [{ descriptor, source: 'package' as const, location: `@example/${name}` }],
    ...(pluginSecrets === undefined ? {} : { pluginSecrets }),
    ...(options.bureau as object),
  });
  bureaus.push(bureau);
  await bureau.plugins.ready();
  const events: DecisionMadeEvent[] = [];
  bureau.addEventListener(
    'decision.made' as never,
    ((event: DecisionMadeEvent) => {
      events.push(event);
    }) as never,
  );
  return {
    bureau,
    setupHost: () => setupHost!,
    startHost: () => startHost!,
    events,
    records: async () => {
      const records = await bureau.internals.auditTrail!.query({ type: 'decision.made' });
      return records.map((record) => ({
        runId: record.runId,
        principal: record.principal,
        detail: record.detail as Record<string, unknown>,
      }));
    },
  };
}

/** What a published event names, and nothing it does not. */
export function eventFields(event: DecisionMadeEvent) {
  return {
    kind: event.kind,
    outcome: event.outcome,
    row: event.row,
    path: event.path,
    taskId: event.taskId,
  };
}
