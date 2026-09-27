import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowCatalog } from './workflow-catalog.ts';
import { WorkflowRefreshCoordinator, type WorkflowRefreshArtifact } from './workflow-refresh.ts';

const definition: RegisteredWorkflowDefinition = { type: 'checkout', version: '1.0.0', tags: [] };

async function manifest(revision = 'r1'): Promise<WorkflowRevisionManifest> {
  return buildWorkflowRevisionManifest(
    buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    { revision },
  );
}

function artifact(value: WorkflowRevisionManifest): WorkflowRefreshArtifact {
  return { manifest: value, bytes: new TextEncoder().encode(JSON.stringify(value)), identity: { name: value.name, revision: value.revision } };
}

describe('WorkflowRefreshCoordinator', () => {
  it('coalesces concurrent checks and sends the cached etag on the next check', async () => {
    const current = await manifest();
    let fetches = 0;
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([['checkout', {
        fetch: async ({ etag }) => {
          fetches++;
          if (etag !== undefined) return { status: 304 as const, etag };
          return { status: 200 as const, etag: 'v1', artifact: artifact(current) };
        },
        warm: async () => definition,
      }]]),
    });

    const [first, second] = await Promise.all([coordinator.refresh('checkout'), coordinator.refresh('checkout')]);
    expect(first.status).toBe('installed');
    expect(second.status).toBe('installed');
    expect(fetches).toBe(1);
    const unchanged = await coordinator.refresh('checkout');
    expect(unchanged.status).toBe('not-modified');
    expect(fetches).toBe(2);
  });

  it('installs and warms without activating, then activates only with a generation fence', async () => {
    const first = await manifest('r1');
    const second = await manifest('r2');
    let next = artifact(first);
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([['checkout', {
        fetch: async () => ({ status: 200 as const, artifact: next }),
        warm: async () => definition,
      }]]),
    });

    await coordinator.refresh('checkout');
    expect(catalog.resolveActive('checkout')).toBeUndefined();
    next = artifact(second);
    const activated = await coordinator.refresh('checkout', { activate: 'if-compatible', expectedGeneration: 0 });
    expect(activated.status).toBe('activated');
    expect(catalog.resolveActive('checkout')?.revision).toBe('r2');
  });

  it('rejects a mismatched immutable artifact digest before warming or installing', async () => {
    const current = await manifest();
    let warmed = false;
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([['checkout', {
        fetch: async () => ({ status: 200 as const, artifact: { ...artifact(current), digest: 'sha256:wrong' } }),
        warm: async () => { warmed = true; return definition; },
      }]]),
    });

    await expect(coordinator.refresh('checkout')).rejects.toThrow('digest');
    expect(warmed).toBe(false);
    expect(await catalog.listInstalledRevisions('checkout')).toHaveLength(0);
    expect(coordinator.diagnostics('checkout')[0]?.state).toBe('failed');
  });
});
