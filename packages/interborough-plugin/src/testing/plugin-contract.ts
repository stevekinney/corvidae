import { afterAll, describe, expect, test } from 'bun:test';
import type { z } from 'zod';

import { definePlugin } from '../define-plugin.ts';
import type { PluginDescriptor } from '../plugin-descriptor.ts';
import { pluginIdentities } from './plugin-identities.ts';

/** One thing wrong with a plugin, as the contract found it. */
export interface PluginContractFailure {
  /** The name of the check that failed. */
  readonly check: string;
  /** What is wrong. */
  readonly message: string;
}

/** The part of one plugin's listing the contract reads; Bureau's `PluginListing` satisfies it. */
export interface PluginTestHostListing {
  /** The plugin's descriptor as the host reports it. */
  readonly descriptor: { readonly name: string };
  /** What the plugin is now; the contract expects `running`. */
  readonly status: string;
  /** What is wrong with it; the contract expects none. */
  readonly problems: readonly { readonly code: string }[];
}

/** A host with one plugin loaded, as far as the contract reads it; Bureau's `Bureau` satisfies it. */
export interface PluginTestHost {
  /** The plugins the host was given. */
  readonly plugins: {
    /** Every plugin, as it stands now. */
    list(): Promise<readonly PluginTestHostListing[]>;
    /** Settles once every running plugin's `afterStart` has settled. */
    ready(): Promise<void>;
  };
  /** Stops the host and removes whatever it created. */
  dispose(): Promise<void>;
}

/**
 * Starts a host that loads only `plugin`, with a value for every secret it declares and the files
 * its `content` ships. The package never builds one itself so that it never imports Bureau; Bureau
 * supplies `createPluginTestHost` from `@lostgradient/bureau/testing`.
 */
export type CreatePluginTestHost = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
) => Promise<PluginTestHost>;

/** What {@link pluginContract} and {@link checkPluginContract} need beside the plugin. */
export interface PluginContractOptions {
  /** Starts the host the plugin is loaded into. */
  readonly createHost: CreatePluginTestHost;
}

interface ContractCheck {
  readonly name: string;
  /** The problem the check found, or `undefined` when the plugin passes it. */
  run(): Promise<string | undefined>;
}

function problemText(problem: { readonly code: string }): string {
  return JSON.stringify(problem);
}

function contractRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginContractOptions,
): { checks: readonly ContractCheck[]; dispose(): Promise<void> } {
  let host: Promise<PluginTestHost> | undefined;
  let listing: Promise<PluginTestHostListing | string> | undefined;
  const started = (): Promise<PluginTestHostListing | string> => {
    listing ??= (async () => {
      host = options.createHost(plugin);
      const running = await host;
      await running.plugins.ready();
      const listed = await running.plugins.list();
      const found = listed.find((candidate) => candidate.descriptor.name === plugin.name);
      return found ?? `The host does not list a plugin named "${plugin.name}".`;
    })();
    return listing;
  };
  const checks: ContractCheck[] = [
    {
      name: 'declares a valid descriptor',
      run: async () => {
        try {
          definePlugin(plugin);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: 'holds identities that read without a host and never repeat',
      run: async () => {
        try {
          const { entries } = await pluginIdentities(plugin);
          const seen = new Set<string>();
          for (const { kind, id } of entries) {
            const key = `${kind} ${id}`;
            if (seen.has(key)) return `The ${kind} "${id}" is contributed twice.`;
            seen.add(key);
          }
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: 'loads into a host and runs',
      run: async () => {
        const found = await started();
        if (typeof found === 'string') return found;
        return found.status === 'running'
          ? undefined
          : `The plugin is "${found.status}", not "running".`;
      },
    },
    {
      name: 'reports no problems',
      run: async () => {
        const found = await started();
        if (typeof found === 'string') return found;
        return found.problems.length === 0 ? undefined : found.problems.map(problemText).join('; ');
      },
    },
  ];
  return {
    checks,
    dispose: async () => {
      // A host that failed to start has nothing to dispose; the check already reported why.
      if (host !== undefined)
        await host.then(
          (running) => running.dispose(),
          () => undefined,
        );
    },
  };
}

/**
 * Runs every conformance check against `plugin` and returns what failed, without registering a
 * test, so a script can report the failures and a test can assert on them. An empty list means the
 * plugin conforms. A check that throws is reported as a failure of that check.
 */
export async function checkPluginContract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginContractOptions,
): Promise<PluginContractFailure[]> {
  const run = contractRun(plugin, options);
  const failures: PluginContractFailure[] = [];
  try {
    for (const check of run.checks) {
      try {
        const message = await check.run();
        if (message !== undefined) failures.push({ check: check.name, message });
      } catch (error) {
        failures.push({
          check: check.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await run.dispose();
  }
  return failures;
}

/**
 * Registers the conformance suite for `plugin` with `bun:test`, one test per check: the descriptor
 * is valid, its identities read without a host and never repeat, and a host that loads only this
 * plugin reports it `running` with no problems, which includes every file the plugin ships
 * resolving the contributions it names.
 *
 * @example
 * ```ts
 * import { definePlugin } from '@lostgradient/interborough-plugin';
 * import { pluginContract } from '@lostgradient/interborough-plugin/testing';
 * import { createPluginTestHost } from '@lostgradient/bureau/testing';
 *
 * const plugin = definePlugin({ name: 'example', version: '1.0.0', description: 'An example.' });
 * pluginContract(plugin, { createHost: createPluginTestHost });
 * ```
 */
export function pluginContract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginContractOptions,
): void {
  describe(`plugin contract: ${plugin.name}`, () => {
    const run = contractRun(plugin, options);
    afterAll(() => run.dispose());
    for (const check of run.checks) {
      test(check.name, async () => {
        expect(await check.run()).toBeUndefined();
      });
    }
  });
}
