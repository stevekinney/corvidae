/**
 * The showcase development host (`bun run dev -- --showcase`): a development host that holds
 * believable content, so a design review or a person can look at every page with data in it.
 *
 * With `--showcase` the host runs on a home of its own (`tmp/interborough-showcase` in the
 * repository, unless `INTERBOROUGH_HOME` names another), so a person's real `~/.interborough` is
 * never touched. The demo plugin is on, so the scripted agents (`demo:assistant` and the rest) are
 * there to chat with. The model catalog holds the stub provider's models (`stub-provider.ts`), whose
 * client answers every model call with a fixed reply and whose key is a fixture, so no real provider
 * key is ever used or read. Once the host listens, `fixtures/showcase-seed.ts` fills it over HTTP,
 * which the end-to-end showcase specification (`tests/e2e/showcase.spec.ts`) does the same way.
 *
 * @module showcase
 */

import type { BungalowEnvironment } from '@lostgradient/bungalow';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin-home.ts';
import type { HostOptions } from './host.ts';
import { fakeProvider, writeProviderHome } from './stub-provider.ts';

/** The flag the development entry takes to run the showcase host. */
export const SHOWCASE_FLAG = '--showcase';

/** The models the stub provider offers, so the model picker has a choice. */
export const SHOWCASE_MODELS = ['sonnet', 'claude-haiku-4-5'] as const;

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
 * `environment` with `INTERBOROUGH_HOME` set to the showcase home under `repositoryDirectory`
 * unless it already names one (an empty value counts as unset).
 */
export function showcaseEnvironment(
  environment: BungalowEnvironment,
  repositoryDirectory: string,
): BungalowEnvironment {
  const named = environment['INTERBOROUGH_HOME'];
  if (named !== undefined && named !== '') return environment;
  return {
    ...environment,
    INTERBOROUGH_HOME: join(repositoryDirectory, ...SHOWCASE_HOME_SEGMENTS),
  };
}

/**
 * Prepares `home` for the showcase host, before the host starts: the provider configuration and
 * its fixture key, then the demo plugin switched on. It replaces the home's `configuration.json`,
 * so a showcase home always starts the same way.
 */
export async function prepareShowcaseHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeProviderHome(home, SHOWCASE_MODELS);
  await enableDemoPlugin(home);
}

/** The provider resolver the showcase host runs on: the stub provider's, which calls no model. */
export function showcaseProviderResolver(): NonNullable<HostOptions['resolveProviderGenerate']> {
  return fakeProvider(SHOWCASE_MODEL_REPLY).resolver;
}
