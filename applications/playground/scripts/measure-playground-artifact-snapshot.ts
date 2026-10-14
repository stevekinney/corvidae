/**
 * A read-only snapshot of the Playground's retained build artifacts, taken at their owners.
 *
 * Every map read here is already exported by the module that owns it, so the probe adds no
 * production code and patches nothing: it only reads `size` and the stored source of each map in
 * the same process as the server that fills them. `measure-playground-probe.ts` calls it between
 * navigation and edit/rebuild cycles to separate retained growth from a rising peak.
 */
import {
  fixtureArtifactByPath,
  fixtureBuildPromiseByKey,
  pageArtifactByPath,
  pageBuildPromiseByKey,
  scenarioArtifactByPath,
  scenarioBuildPromiseByKey,
  shellArtifactByPath,
} from '../src/build-artifacts-shared.ts';
import { fixtureEntryByKey } from '../src/fixture-bundle.ts';
import { componentManifestCache } from '../src/manifest-cache.ts';
import { pageEntryByName } from '../src/page-bundle.ts';
import { bundleEntryByKey } from '../src/scenario-bundle.ts';
import { shellEntryByName } from '../src/shell-bundle.ts';
import { sseClients } from '../src/sse-broadcast.ts';
import { artifactMapFootprint } from './measure-playground-inventory.ts';

export type FamilySnapshot = { entryPointers: number; artifacts: number; artifactBytes: number };

export type RetainedArtifactSnapshot = {
  page: FamilySnapshot;
  shell: FamilySnapshot;
  scenario: FamilySnapshot;
  fixture: FamilySnapshot;
  totalArtifacts: number;
  totalArtifactBytes: number;
  inFlightBuilds: number;
  cachedManifests: number;
  /** Open `/events` streams the server still holds (`sse-broadcast.ts`'s `sseClients`). */
  liveReloadSubscribers: number;
};

function family(
  entryPointers: ReadonlyMap<string, unknown>,
  artifacts: ReadonlyMap<string, string>,
): FamilySnapshot {
  const footprint = artifactMapFootprint(artifacts);
  return {
    entryPointers: entryPointers.size,
    artifacts: footprint.entries,
    artifactBytes: footprint.bytes,
  };
}

export function snapshotRetainedArtifacts(): RetainedArtifactSnapshot {
  const page = family(pageEntryByName, pageArtifactByPath);
  const shell = family(shellEntryByName, shellArtifactByPath);
  const scenario = family(bundleEntryByKey, scenarioArtifactByPath);
  const fixture = family(fixtureEntryByKey, fixtureArtifactByPath);
  const families = [page, shell, scenario, fixture];
  return {
    page,
    shell,
    scenario,
    fixture,
    totalArtifacts: families.reduce((sum, item) => sum + item.artifacts, 0),
    totalArtifactBytes: families.reduce((sum, item) => sum + item.artifactBytes, 0),
    inFlightBuilds:
      pageBuildPromiseByKey.size + scenarioBuildPromiseByKey.size + fixtureBuildPromiseByKey.size,
    cachedManifests: componentManifestCache.size,
    liveReloadSubscribers: sseClients.size,
  };
}
