/**
 * The showcase development host (`bun run dev -- --showcase`): a development host that holds the
 * sample world (`tmp/design-review/decisions.md`), so a design review or a person can look at every
 * page with the boards' data in it.
 *
 * With `--showcase` the host runs on a home of its own (`tmp/interborough-showcase` in the
 * repository, or the directory `INTERBOROUGH_SHOWCASE_HOME` names). It ignores `INTERBOROUGH_HOME`,
 * because the sample world's seed (`fixtures/sample-world-seed.ts`) empties the showcase home and
 * plays its story into it on every start, and a home set for everyday use must never be rewritten by
 * a flag. The seed leaves the host running at Monday, Nov 2, a little after 10:45 AM on its offset
 * clock, with real timers. The sample world's built-in agents and tools (`showcase-agents.ts`:
 * Assistant, Echo, Tool runner, Request human input, Model switcher and Workflow author) are
 * registered by this host alone, as `HostOptions.extraAgents`; the Demo plugin is off. The model
 * catalog holds the stub provider's models (`stub-provider.ts`), whose client answers every model
 * call with a fixed reply and whose key is a fixture, so no real provider key is ever used or read;
 * a built-in agent's step that a model override sends to that provider answers from the agent's
 * script instead ({@link showcaseProviderResolver}).
 * The end-to-end showcase specification (`tests/e2e/showcase.spec.ts`) opens a host seeded the same
 * way.
 *
 * @module showcase
 */

import type { BungalowEnvironment } from '@lostgradient/bungalow';
import type { BureauPluginEntry } from '@lostgradient/bureau';
import {
  readBackendDescriptors,
  withBackendDescriptors,
  type GenerateFunction,
} from '@lostgradient/operative';
import guardrails from '@lostgradient/plugin-guardrails';
import ollama from '@lostgradient/plugin-ollama';
import voyage from '@lostgradient/plugin-voyage';
import type { AlertingOptions } from '@lostgradient/weft';
import { join } from 'node:path';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import type { HostOptions, RunAgentLookup } from './host.ts';
import { workspacePlugins } from './plugins.ts';
import {
  showcaseAgentScripts,
  showcaseBuiltInAgents,
  type ShowcaseAgentIdentifier,
  type ShowcasePacing,
} from './showcase-agents.ts';
import { fakeProvider } from './stub-provider.ts';

/** The flag the development entry takes to run the showcase host. */
export const SHOWCASE_FLAG = '--showcase';

/**
 * The models the stub provider offers, so the model picker has a choice: the sample world's
 * Anthropic catalog (Opus 5.5, Sonnet 5.5 and Haiku 5.5, the last two Model switcher's), and the
 * two the seeded agent files name.
 */
export const SHOWCASE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'sonnet',
  'claude-haiku-4-5',
] as const;

/** What the stub provider's client answers to every model call. */
export const SHOWCASE_MODEL_REPLY =
  'This reply comes from the showcase provider stub. No model was called.';

/** Where the showcase host keeps its state, relative to the repository, unless a home is set. */
const SHOWCASE_HOME_SEGMENTS = ['tmp', 'interborough-showcase'] as const;

/** `argv` without {@link SHOWCASE_FLAG}, and whether it was there. */
export function splitShowcaseFlag(argv: readonly string[]): {
  readonly showcase: boolean;
  readonly rest: readonly string[];
} {
  return {
    showcase: argv.includes(SHOWCASE_FLAG),
    rest: argv.filter((argument) => argument !== SHOWCASE_FLAG),
  };
}

/**
 * `environment` with `INTERBOROUGH_HOME` replaced by the showcase home: the directory
 * `INTERBOROUGH_SHOWCASE_HOME` names, or `tmp/interborough-showcase` under `repositoryDirectory`
 * (an empty value counts as unset). An `INTERBOROUGH_HOME` already in the environment is ignored on
 * purpose, so the showcase never rewrites a person's real home.
 */
export function showcaseEnvironment(
  environment: BungalowEnvironment,
  repositoryDirectory: string,
): BungalowEnvironment {
  const named = environment['INTERBOROUGH_SHOWCASE_HOME'];
  const home =
    named !== undefined && named !== ''
      ? named
      : join(repositoryDirectory, ...SHOWCASE_HOME_SEGMENTS);
  return { ...environment, INTERBOROUGH_HOME: home };
}

/**
 * The provider resolver the showcase host runs on: the stub provider's, which calls no model, with
 * one exception. A step of a built-in agent's run reaches the provider when a person saved a model
 * override on the agent (decisions.md, "B01 fix round, Nov 3"), and that step answers from the
 * agent's own entry in `scripts`, so Tool runner still looks an order up and asks to refund it on
 * the model a person chose. Whose run a step belongs to is read per call through `agentOfRun`, the
 * host's lookup in its own Bureau; a step of any other agent, or of a run the lookup does not know,
 * gets the stub's reply.
 */
export function showcaseProviderResolver(
  agentOfRun: RunAgentLookup,
  scripts: Readonly<Record<ShowcaseAgentIdentifier, GenerateFunction>>,
): NonNullable<HostOptions['resolveProviderGenerate']> {
  const stub = fakeProvider(SHOWCASE_MODEL_REPLY).resolver;
  const scriptOf = new Map<string, GenerateFunction>(Object.entries(scripts));
  return (definitions, provider, streamEventTarget, streaming) => {
    const provided = stub(definitions, provider, streamEventTarget, streaming);
    const generate: GenerateFunction = async (context) => {
      const agent = context.runId === undefined ? undefined : await agentOfRun(context.runId);
      const script = agent === undefined ? undefined : scriptOf.get(agent);
      return (script ?? provided)(context);
    };
    // The provider's generate may carry its catalog row, which a run reads its model from.
    const attached = readBackendDescriptors(provided);
    return attached.length === 0 ? generate : withBackendDescriptors(generate, attached);
  };
}

/**
 * The plugins the showcase host loads: the workspace's own, and the Guardrails, Ollama and Voyage
 * plugins, which the sample world lists on Settings › Plugins (decisions.md, "Owner answers during
 * B01": Guardrails runs, Ollama and Voyage are disabled).
 */
export function showcasePlugins(): readonly BureauPluginEntry[] {
  return [
    ...workspacePlugins(),
    { descriptor: guardrails, source: 'package', location: '@lostgradient/plugin-guardrails' },
    { descriptor: ollama, source: 'package', location: '@lostgradient/plugin-ollama' },
    { descriptor: voyage, source: 'package', location: '@lostgradient/plugin-voyage' },
  ];
}

/**
 * The HTTP client the showcase's hooks deliver with: it answers every delivery `200 OK` itself, so a
 * sample hook keeps its delivery records and never posts to the address it names
 * (`events.pagerduty.com`, `hooks.slack.com`, `audit.example.com`).
 */
export const showcaseHookFetch: typeof fetch = Object.assign(
  async () => new Response('ok', { status: 200 }),
  { preconnect: fetch.preconnect },
);

/** The showcase's storage warning level: the threshold of its `storage.size` alert rule, 1 GB. */
export const SHOWCASE_STORAGE_WARNING_BYTES = 1024 ** 3;

/**
 * The showcase's alert rules (decisions.md, "Coordinator call: the firing storage.size alert …"):
 * one `storage.size` rule at {@link SHOWCASE_STORAGE_WARNING_BYTES}, which a fresh install doesn't
 * have, so the sample world's storage alert can fire. Its action is `webhook` with no webhook
 * targets, so firing posts nothing and logs nothing; the alert is read from the engine.
 */
export const SHOWCASE_ALERTS: AlertingOptions = {
  rules: [{ metric: 'storage.size', threshold: SHOWCASE_STORAGE_WARNING_BYTES, action: 'webhook' }],
};

/** The built-in agents the sample world shares over A2A, as the board draws Settings › A2A. */
const SHOWCASE_A2A_AGENTS = ['assistant', 'tool-runner'] as const;

/**
 * What a showcase host is started with beside its environment: the stub provider's resolver (built
 * from the host's run lookup, over the same scripts the built-in agents answer from), the sample
 * world's built-in agents, tools and goal checks as extra agents, its plugins, hooks that
 * deliver without posting, its storage alert rule with no periodic size report to resolve it, and its nightly clean-up in the sample world's Central time, whatever
 * zone the machine is in. The development entry (`dev.ts`), the end-to-end showcase host and the
 * showcase host test all start it with these; the sample world's seed passes `pacing` to pace the
 * scripted agents.
 */
export function showcaseHostOptions(
  pacing: ShowcasePacing = {},
): Pick<
  HostOptions,
  | 'extraAgents'
  | 'a2aAgents'
  | 'resolveProviderGenerateFor'
  | 'nightlyCleanUp'
  | 'plugins'
  | 'hookFetch'
  | 'alerts'
  | 'storageSizeReportIntervalMilliseconds'
> {
  const scripts = showcaseAgentScripts(pacing);
  return {
    extraAgents: showcaseBuiltInAgents(pacing, scripts),
    // Settings › A2A shows Assistant and Tool runner shared and the rest not (board
    // PageSettingsSections, "A2A · /settings/a2a").
    a2aAgents: SHOWCASE_A2A_AGENTS,
    resolveProviderGenerateFor: (agentOfRun) => showcaseProviderResolver(agentOfRun, scripts),
    nightlyCleanUp: { timeZone: SAMPLE_TIME_ZONE },
    plugins: showcasePlugins(),
    hookFetch: showcaseHookFetch,
    alerts: SHOWCASE_ALERTS,
    // The sample world's storage holds 1.6 GB (its seed reports it at 9:05 AM on Nov 2); the
    // engine's own report of the real database's few megabytes would resolve the alert a minute
    // later, so it is off.
    storageSizeReportIntervalMilliseconds: 0,
  };
}
