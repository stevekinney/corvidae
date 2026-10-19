/**
 * Conditional-refresh source fixtures (COR-166). Registers one refresh source
 * on each of three eager fixture workflows, each chosen to leave the Registry's
 * refresh panel in one state `tests/e2e/22-operate-workflow-refresh.spec.ts`
 * has to render honestly. No host registers a refresh source otherwise, because a
 * source is code the host supplies (`fetch`, `warm`, `validateRuntime`), not
 * something an operator can add over the wire.
 *
 * - `REFRESH_COMPATIBLE_WORKFLOW`: serves the exact manifest the engine already
 *   has active. Under the default strict compatibility policy only the active
 *   revision itself is compatible, so this is the one candidate that activates;
 *   activating it re-stamps the generation. The first check answers 200 and a
 *   later one 304 on the ETag.
 * - `REFRESH_INCOMPATIBLE_WORKFLOW`: serves a candidate with another workflow
 *   version. It installs and warms, then activation is refused with the
 *   catalog's structured reasons.
 * - `REFRESH_CORRUPT_WORKFLOW`: serves an artifact whose digest does not match
 *   its bytes, so every check is refused as an integrity failure and nothing is
 *   installed.
 *
 * The manifests come from the real published builders, never a console
 * reimplementation.
 */
import {
  buildWorkflowContract,
  buildWorkflowRevisionManifest,
  type RegisteredWorkflowDefinition,
  type WorkflowRefreshArtifact,
  type WorkflowRefreshSource,
  type WorkflowRevisionManifest,
} from '@lostgradient/weft';

export const REFRESH_COMPATIBLE_WORKFLOW = 'signal-stepped';
export const REFRESH_INCOMPATIBLE_WORKFLOW = 'long-sleeper';
export const REFRESH_CORRUPT_WORKFLOW = 'review-gate';

/** The revision id of the incompatible candidate, which the spec asserts on directly. */
export const REFRESH_INCOMPATIBLE_REVISION = 'long-sleeper-refresh-candidate';

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern this file follows. */
export interface WorkflowRefreshEngine {
  getWorkflowDefinition(name: string): RegisteredWorkflowDefinition | undefined;
  workflows: {
    getActive(name: string): Promise<{ readonly revision: string } | null>;
    getRevision(
      name: string,
      revision: string,
    ): Promise<{ readonly manifest: WorkflowRevisionManifest } | null>;
    registerRefreshSource(name: string, source: WorkflowRefreshSource): Promise<void>;
  };
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function artifactOf(manifest: WorkflowRevisionManifest): Promise<WorkflowRefreshArtifact> {
  const identity = { name: manifest.name, revision: manifest.revision };
  const runtime = 'bun@1.4.2';
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, identity, runtime }));
  return { manifest, bytes, digest: await digestOf(bytes), identity, runtime };
}

/** Serves `artifact`: 200 with the digest as its ETag, then 304 for a request carrying that ETag. */
function sourceOf(
  engine: WorkflowRefreshEngine,
  name: string,
  artifact: WorkflowRefreshArtifact,
): WorkflowRefreshSource {
  return {
    fetch: async ({ etag }) =>
      etag === artifact.digest
        ? { status: 304 as const, etag }
        : { status: 200 as const, etag: artifact.digest, artifact },
    warm: async () => {
      const definition = engine.getWorkflowDefinition(name);
      if (definition === undefined) throw new Error(`"${name}" is not registered.`);
      return definition;
    },
    validateRuntime: () => {},
  };
}

/** Registers the three refresh sources on `engine`. */
export async function seedRefreshSources(engine: WorkflowRefreshEngine): Promise<void> {
  const active = await engine.workflows.getActive(REFRESH_COMPATIBLE_WORKFLOW);
  const record =
    active === null
      ? null
      : await engine.workflows.getRevision(REFRESH_COMPATIBLE_WORKFLOW, active.revision);
  if (record === null) {
    throw new Error(`"${REFRESH_COMPATIBLE_WORKFLOW}" has no active revision to refresh to.`);
  }
  await engine.workflows.registerRefreshSource(
    REFRESH_COMPATIBLE_WORKFLOW,
    sourceOf(engine, REFRESH_COMPATIBLE_WORKFLOW, await artifactOf(record.manifest)),
  );

  const incompatible = await buildWorkflowRevisionManifest(
    buildWorkflowContract({ name: REFRESH_INCOMPATIBLE_WORKFLOW, version: '2.0.0' }),
    { revision: REFRESH_INCOMPATIBLE_REVISION },
  );
  await engine.workflows.registerRefreshSource(
    REFRESH_INCOMPATIBLE_WORKFLOW,
    sourceOf(engine, REFRESH_INCOMPATIBLE_WORKFLOW, await artifactOf(incompatible)),
  );

  const corrupt = await buildWorkflowRevisionManifest(
    buildWorkflowContract({ name: REFRESH_CORRUPT_WORKFLOW, version: '3.0.0' }),
    { revision: 'review-gate-refresh-corrupt' },
  );
  await engine.workflows.registerRefreshSource(
    REFRESH_CORRUPT_WORKFLOW,
    sourceOf(engine, REFRESH_CORRUPT_WORKFLOW, {
      ...(await artifactOf(corrupt)),
      digest: 'sha256:not-the-digest-of-these-bytes',
    }),
  );
}
