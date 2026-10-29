/**
 * What the host reports about itself (COR-1732): the Bureau's reading, the engine server's lease,
 * workers, and connections, the build it serves, and the providers it offers. Every field is an
 * identifier, a status, a count, a timestamp, or a path the owner of the host already knows.
 * Nothing in it is a credential: a provider appears as its name and its models, never its key,
 * its secret's file, or a base URL.
 *
 * @module host-diagnostics
 */

import type { BureauDiagnostics } from '@lostgradient/bureau';
import type { RegistryAgnosticEngine, WeftServer } from '@lostgradient/weft';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { InterboroughProviderName, LoadedProviders } from './providers.ts';

/** The build the host serves, as {@link HostDiagnostics.build} reports it when `index.html` exists. */
export type HostBuildDiagnostics = {
  /** The directory the host serves the application from. */
  readonly directory: string;
  /** When the build's `index.html` was last modified, in milliseconds since the epoch. */
  readonly indexModifiedAt: number;
};

/** One model provider the host offers, as {@link HostDiagnostics.providers} reports it. */
export type HostProviderDiagnostics = {
  /** The provider's name: `anthropic`, `openai`, or `gemini`. */
  readonly name: InterboroughProviderName;
  /** The identifiers of the models the host's catalog offers from this provider. */
  readonly models: readonly string[];
};

/** The engine server's own state, as {@link HostDiagnostics.weft} reports it. */
export type HostWeftDiagnostics = {
  /** The served engine's last-known ownership-lease health (`engine.getLeaseHealth()`). */
  readonly lease: ReturnType<RegistryAgnosticEngine['getLeaseHealth']>;
  /** The connected remote workers, as `weft.workers.list` projects them at the time of the reading. */
  readonly workers: ReturnType<WeftServer['registry']['getWorkerSummaries']>;
  /** How many transport subscribers and workers the server holds (`server.connections()`). */
  readonly connections: ReturnType<WeftServer['connections']>;
};

/**
 * A point-in-time reading of the host, from {@link Host.diagnostics}. The lock holder is not part
 * of it: while the host runs it is always this process, and a second host that finds the lock
 * taken learns the holder from `BungalowLockedError`.
 */
export type HostDiagnostics = {
  /** The Bureau's reading (`bureau.internals.diagnostics()`): recovery, watchers, and counts. */
  readonly bureau: BureauDiagnostics;
  /** The engine server's lease, workers, and connections. */
  readonly weft: HostWeftDiagnostics;
  /** The build directory and its `index.html`'s modification time, or `null` while `index.html` is absent. */
  readonly build: HostBuildDiagnostics | null;
  /** The providers the host offers, in the order their models appear in the catalog. */
  readonly providers: readonly HostProviderDiagnostics[];
};

/**
 * The build directory and when its `index.html` last changed, or `null` when there is no such
 * file. Only a missing file is `null`; any other failure to read it is thrown.
 */
export function buildDiagnostics(buildDirectory: string): HostBuildDiagnostics | null {
  const index = statSync(join(buildDirectory, 'index.html'), { throwIfNoEntry: false });
  if (index === undefined || !index.isFile()) return null;
  return { directory: buildDirectory, indexModifiedAt: index.mtimeMs };
}

/**
 * The offered providers, each with its models. A provider is listed when the host holds a key for
 * it, even if an allowlist left it no models; the key itself is never read here.
 */
export function providerDiagnostics(
  providers: LoadedProviders,
): readonly HostProviderDiagnostics[] {
  return [...providers.apiKeys.keys()].map((name) => ({
    name,
    models: providers.rows.filter((row) => row.provider === name).map((row) => row.model),
  }));
}
