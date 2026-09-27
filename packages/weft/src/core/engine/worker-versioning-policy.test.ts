import { describe, expect, it } from 'bun:test';
import { decode } from '../codec.ts';
import { Engine } from './index.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { workflow } from '../types.ts';
import type { WorkflowState } from '../types.ts';

describe('workflow worker versioning integration', () => {
  it('persists the default pinned binding in the atomic workflow start batch', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'versioned-start' }).execute(async function* () {
        return 'ok';
      }),
    );

    const handle = await engine.start('versioned-start', null, { id: 'versioned-start-1' });
    const state = decode((await storage.get(KEYS.workflow(handle.id)))!) as WorkflowState;
    expect(state.workerVersioningPolicy).toEqual({ mode: 'pinned' });
    expect(state.workerBinding?.current.workflowId).toBe(handle.id);
    expect(state.workerBinding?.current.workflowRevision).toBe(state.revision);
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();
  });
});
