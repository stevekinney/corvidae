/**
 * The production entry (`bun run --filter=@lostgradient/interborough start`, through
 * `supervisor.ts`): start the host on the existing `build/` and serve it. It builds nothing and
 * watches nothing; `bun run build` makes `build/`, and a restart (`POST /host/restart`) starts this
 * process again under the supervisor.
 *
 * The host runs with `development: false`, so it serves neither the reload stream nor the client
 * that listens to it.
 */

import type { BungalowEnvironment } from '@lostgradient/bungalow';
import { reviewedToolOperations } from '@lostgradient/bureau/tool-operations';
import { oidc } from '@lostgradient/credentials/browser-sign-in';
import { approvalOnlyPolicy, createTool, createToolbox, validateApprovalBinding } from 'armorer';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { publishedBrowserBuildDirectory } from './build-info.ts';
import { connectionLines } from './connection-details.ts';
import { processEnvironment, resolveBuildDirectory } from './environment-configuration.ts';
import { startHost, type HostOptions } from './host.ts';
import { RESTART_EXIT_CODE } from './restart.ts';
import { installShutdownSignals } from './shutdown-signals.ts';

type DeploymentOptions = Pick<
  HostOptions,
  'workspaceAuthentication' | 'sharedBrowserSignIn' | 'reviewedOperations'
>;

const deploymentOptionNames = [
  'workspaceAuthentication',
  'sharedBrowserSignIn',
  'reviewedOperations',
] as const satisfies readonly (keyof DeploymentOptions)[];

const deploymentFactories = Object.freeze({
  oidc,
  reviewedToolOperations,
  createTool,
  createToolbox,
  approvalOnlyPolicy,
  validateApprovalBinding,
});

/**
 * An operator may configure shared authentication and reviewed operations with a local module.
 * A deployed module runs as trusted code. Use the host's factories so its identity proofs and
 * tool policies belong to the same module instances the listener uses to validate requests.
 */
export async function loadDeploymentOptions(
  environment: BungalowEnvironment,
): Promise<DeploymentOptions> {
  const path = environment['INTERBOROUGH_HOST_CONFIGURATION'];
  if (path === undefined) return {};
  const file = isAbsolute(path) ? await stat(path) : undefined;
  if (!file?.isFile()) {
    throw new Error('INTERBOROUGH_HOST_CONFIGURATION must name an absolute local file.');
  }
  const module: unknown = await import(pathToFileURL(path).href);
  if (
    module === null ||
    typeof module !== 'object' ||
    !('default' in module) ||
    typeof module.default !== 'function'
  ) {
    throw new TypeError('The host configuration module must default export a function.');
  }
  const configured: unknown = await Reflect.apply(module.default, undefined, [deploymentFactories]);
  if (
    configured === null ||
    typeof configured !== 'object' ||
    (Object.getPrototypeOf(configured) !== Object.prototype &&
      Object.getPrototypeOf(configured) !== null) ||
    Reflect.ownKeys(configured).some(
      (key) => !deploymentOptionNames.some((supported) => key === supported),
    )
  ) {
    throw new TypeError('The host configuration module returned unsupported options.');
  }
  return configured;
}

/** Run the foreground production host with the caller's resolved build directory. */
export async function serveHost(
  environment: BungalowEnvironment,
  buildDirectory: string,
): Promise<void> {
  /** Stop the host, then exit with `code`. A host that did not stop cleanly exits 1, which ends the supervisor. */
  async function stop(code: number): Promise<never> {
    try {
      const host = await starting;
      await host.close();
    } catch (error) {
      console.error('The host did not stop cleanly.', error);
      process.exit(1);
    }
    process.exit(code);
  }

  if (publishedBrowserBuildDirectory(buildDirectory) === undefined) {
    throw new Error('Published browser generation is missing');
  }
  const deployment = await loadDeploymentOptions(environment);
  // The restart route can receive a request before startHost returns.
  const starting = startHost({
    ...deployment,
    environment,
    buildDirectory,
    development: false,
    onRestartRequested: () => stop(RESTART_EXIT_CODE),
  });
  const host = await starting;
  // URL normalizes away HTTP’s default port, but the startup line always names the bound port.
  console.info(
    `Interborough is listening on ${host.url.protocol}//${host.url.hostname}:${host.url.port || 80}`,
  );
  console.info(`Its state lives in ${host.stateDescription}`);
  for (const line of connectionLines(host.url)) console.info(line);

  installShutdownSignals(process, () => stop(0));
}

if (import.meta.main) {
  const environment = processEnvironment();
  await serveHost(environment, resolveBuildDirectory(environment));
}
