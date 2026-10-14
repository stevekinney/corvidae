import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadLayoutMap } from './layout-map.ts';
import { type MirrorTarget, mirrorTargets as currentMirrorTargets } from './target-definitions.ts';
import { configurationWorkspace } from './typescript-configuration.ts';

export interface HistoricalPublicationRouting {
  targetFor: (workspace: string) => MirrorTarget;
  target: MirrorTarget;
  targetDirectory: string;
  configurationTarget: MirrorTarget;
  configurationDirectory: string;
}

/**
 * The targets a historical routing may name. A commit from before the agent-bureau target was
 * retired can still route a workspace there; that is refused, because nothing publishes from it.
 */
const mirrorTargets = new Set<MirrorTarget>(currentMirrorTargets);

export async function loadHistoricalPublicationRouting(
  corvidaeRoot: string,
  workspace: string,
  corvidaeDirectory: string,
): Promise<HistoricalPublicationRouting> {
  const targetDefinitionsPath = join(corvidaeRoot, 'scripts/mirror/target-definitions.ts');
  const manifestsPath = join(corvidaeRoot, 'scripts/mirror/manifests.ts');
  const routingPath = (await Bun.file(targetDefinitionsPath).exists())
    ? targetDefinitionsPath
    : (await Bun.file(manifestsPath).exists())
      ? manifestsPath
      : undefined;
  if (!routingPath) {
    throw new Error(
      `${workspace}: historical target routing is missing ${targetDefinitionsPath} and ${manifestsPath}`,
    );
  }
  let historicalModule: { targetFor?: unknown };
  try {
    historicalModule = (await import(pathToFileURL(routingPath).href)) as {
      targetFor?: unknown;
    };
  } catch (error) {
    throw new Error(
      `${workspace}: historical target routing could not be loaded from ${routingPath}`,
      { cause: error },
    );
  }
  if (typeof historicalModule.targetFor !== 'function') {
    throw new Error(`${workspace}: historical target routing does not export targetFor`);
  }
  const targetFor = historicalModule.targetFor as (name: string) => string;
  const readTarget = (name: string): MirrorTarget => {
    let target: string;
    try {
      target = targetFor(name);
    } catch (error) {
      throw new Error(`${workspace}: historical routing cannot place ${name}`, { cause: error });
    }
    if (!mirrorTargets.has(target as MirrorTarget)) {
      throw new Error(`${workspace}: historical routing returned an invalid target for ${name}`);
    }
    return target as MirrorTarget;
  };
  const layoutPath = join(corvidaeRoot, 'scripts/mirror/layout-map.json');
  if (!(await Bun.file(layoutPath).exists())) {
    throw new Error(`${workspace}: historical layout is missing ${layoutPath}`);
  }
  let layout: Awaited<ReturnType<typeof loadLayoutMap>>;
  try {
    layout = await loadLayoutMap(layoutPath);
  } catch (error) {
    throw new Error(`${workspace}: historical layout could not be loaded`, { cause: error });
  }
  const workspaceLayout = layout.workspaces[workspace];
  if (!workspaceLayout || workspaceLayout.disposition !== 'emit') {
    throw new Error(`${workspace}: historical layout does not emit this workspace`);
  }
  if (workspaceLayout.corvidaeDirectory !== corvidaeDirectory) {
    throw new Error(
      `${workspace}: historical layout directory disagrees with the supplied workspace directory`,
    );
  }
  const configurationLayout = layout.workspaces[configurationWorkspace];
  if (!configurationLayout || configurationLayout.disposition !== 'emit') {
    throw new Error(`${workspace}: historical layout does not emit ${configurationWorkspace}`);
  }
  return {
    targetFor: readTarget,
    target: readTarget(workspace),
    targetDirectory: workspaceLayout.targetDirectory,
    configurationTarget: readTarget(configurationWorkspace),
    configurationDirectory: configurationLayout.targetDirectory,
  };
}
