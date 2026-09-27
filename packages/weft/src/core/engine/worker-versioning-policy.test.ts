import { describe, expect, it } from 'bun:test';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { decode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('workflow worker versioning integration', () => {
  it('persists the default pinned binding in the atomic workflow start batch', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'versioned-start', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* () {
          return 'ok';
        },
      ),
    );
    const revisions = await engine.workflows.listRevisions('versioned-start');
    const manifest = {
      manifestVersion: 1,
      protocolVersion: 1,
      sdkVersion: 'test',
      runtime: { name: 'bun', version: 'test' },
      deployment: {
        name: 'test-deployment',
        buildId: 'build-1',
        artifactDigest: 'sha256:artifact',
      },
      workflows: {
        'versioned-start': {
          workflowVersion: '0.0.0',
          workflowRevision: revisions[0]?.manifest.revision ?? '',
          contractHash: 'sha256:workflow',
          activities: { charge: { contractHash: 'sha256:charge', implementationRevision: '1' } },
        },
      },
      capabilities: {},
    } satisfies WorkerManifest;
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: manifest.deployment.name,
      buildId: manifest.deployment.buildId,
      artifactDigest: manifest.deployment.artifactDigest,
      manifestDigest: 'sha256:manifest',
      manifest,
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: manifest.deployment.name,
      currentBuildId: manifest.deployment.buildId,
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const handle = await engine.start('versioned-start', null, { id: 'versioned-start-1' });
    const state = decode((await storage.get(KEYS.workflow(handle.id)))!) as WorkflowState;
    expect(state.workerVersioningPolicy).toEqual({ mode: 'pinned' });
    expect(state.workerBinding?.current.workflowId).toBe(handle.id);
    expect(state.workerBinding?.current.workflowRevision).toBe(state.revision);
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();
  });
});
