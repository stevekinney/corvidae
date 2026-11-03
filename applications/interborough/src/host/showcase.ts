/**
 * The showcase development host (`bun run dev -- --showcase`): a development host that holds
 * believable content, so a design review or a person can look at every page with data in it.
 *
 * With `--showcase` the host runs on a home of its own (`tmp/interborough-showcase` in the
 * repository, or the directory `INTERBOROUGH_SHOWCASE_HOME` names). It ignores `INTERBOROUGH_HOME`,
 * because preparing the showcase home replaces its `configuration.json`, and a home set for everyday
 * use must never be rewritten by a flag. The sample world's built-in agents and tools
 * (`showcase-agents.ts`: Assistant, Echo, Tool runner, Request human input, Model switcher and
 * Workflow author) are registered by this host alone, as `HostOptions.extraAgents`. The demo plugin
 * is on, so its scripted agents (`demo:assistant` and the rest) are there to chat with too. The model catalog holds the stub provider's models (`stub-provider.ts`), whose
 * client answers every model call with a fixed reply and whose key is a fixture, so no real provider
 * key is ever used or read. Once the host listens, `fixtures/showcase-seed.ts` fills it over HTTP,
 * which the end-to-end showcase specification (`tests/e2e/showcase.spec.ts`) does the same way.
 *
 * @module showcase
 */

import type { BungalowEnvironment } from '@lostgradient/bungalow';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SHOWCASE_WORKFLOW_FILES } from '../../fixtures/showcase-content.ts';
import { enableDemoPlugin } from './demo-plugin-home.ts';
import { WORKFLOW_DIRECTORY_NAME, type HostOptions } from './host.ts';
import { showcaseBuiltInAgents } from './showcase-agents.ts';
import { fakeProvider, writeProviderHome } from './stub-provider.ts';

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
 * Prepares `home` for the showcase host, before the host starts: the provider configuration and
 * its fixture key, the demo plugin switched on, and the sample world's workflow files
 * (`SHOWCASE_WORKFLOW_FILES`: Release notes, Triage inbox, and Order refund, which can't load). It
 * replaces the home's `configuration.json` and those files, so a showcase home always starts the
 * same way.
 */
export async function prepareShowcaseHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeProviderHome(home, SHOWCASE_MODELS);
  await enableDemoPlugin(home);
  const workflows = join(home, WORKFLOW_DIRECTORY_NAME);
  await mkdir(workflows, { recursive: true });
  for (const file of SHOWCASE_WORKFLOW_FILES) {
    await writeFile(join(workflows, `${file.id}.json`), file.text);
  }
}

/** The provider resolver the showcase host runs on: the stub provider's, which calls no model. */
export function showcaseProviderResolver(): NonNullable<HostOptions['resolveProviderGenerate']> {
  return fakeProvider(SHOWCASE_MODEL_REPLY).resolver;
}

/**
 * What a showcase host is started with beside its environment: the stub provider's resolver, and
 * the sample world's built-in agents and tools as extra agents. The development entry
 * (`dev.ts`), the end-to-end showcase host and the showcase host test all start it with these.
 */
export function showcaseHostOptions(): Pick<
  HostOptions,
  'extraAgents' | 'resolveProviderGenerate'
> {
  return {
    extraAgents: showcaseBuiltInAgents(),
    resolveProviderGenerate: showcaseProviderResolver(),
  };
}
