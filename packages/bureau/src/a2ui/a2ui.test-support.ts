import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/storage';

import { createDurableEventHistory } from '../durable-event-history';
import {
  createInteractiveSurfaces,
  type InteractiveSurfaces,
  type InteractiveSurfaceTask,
} from '../interactive-surface/store';
import {
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  type InteractiveSurface,
  type InteractiveSurfaceActionDefinition,
} from '../interactive-surface/types';
import { createA2uiAdapter, type A2uiAdapter } from './adapter';

export const OWNER = 'api-key:alice';
export const TASK = 'agent-run-1';
export const version = INTERACTIVE_SURFACE_CONTRACT_VERSION;

/** A store over memory with one task, plus an adapter over it. */
export function a2uiHarness(
  tasks: Record<string, InteractiveSurfaceTask> = {
    [TASK]: { owner: OWNER, contextId: 'session-1' },
  },
) {
  const runtime = createManualRuntimeServices();
  const storage = new MemoryStorage();
  const history = createDurableEventHistory(storage, runtime);
  const table = new Map(Object.entries(tasks));
  const listeners = new Map<string, (status: 'completed' | 'failed' | 'canceled') => void>();
  const surfaces: InteractiveSurfaces = createInteractiveSurfaces({
    storage,
    history,
    task: async (taskId) => table.get(taskId),
    now: () => runtime.clock.now(),
    watchTask: (taskId, listener) => listeners.set(taskId, listener),
  });
  const adapter: A2uiAdapter = createA2uiAdapter({ surfaces });
  function settle(taskId: string, status: 'completed' | 'failed' | 'canceled') {
    const task = table.get(taskId);
    if (task === undefined) throw new Error(`no task ${taskId}`);
    table.set(taskId, { ...task, settled: status });
    listeners.get(taskId)?.(status);
  }
  async function snapshot(surfaceId: string, taskId = TASK): Promise<InteractiveSurface> {
    const receipt = await surfaces.snapshot({
      type: 'surface.snapshot',
      contractVersion: version,
      taskId,
      surfaceId,
    });
    if (receipt.outcome !== 'found') throw new Error(`snapshot was ${receipt.outcome}`);
    return receipt.surface;
  }
  return { surfaces, adapter, settle, snapshot, table };
}

export const BASIC = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
export const CINDER = 'https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json';

export const confirmAction: InteractiveSurfaceActionDefinition = {
  name: 'confirm',
  intent: 'submit',
  continuation: { type: 'signal', sessionId: 'session-1', signalName: 'confirmed' },
  valueSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
    additionalProperties: false,
  },
};

export function createMessage(surfaceId = 'panel', catalogId = BASIC) {
  return { version: 'v0.9.1', createSurface: { surfaceId, catalogId } };
}

/** A whole, valid basic-catalog surface: heading, note field, and a button that raises `confirm`. */
export function panelComponents() {
  return [
    { id: 'title', component: 'Text', text: 'Confirm the window' },
    { id: 'note', component: 'TextField', label: 'Note', value: { path: '/note' } },
    { id: 'go-label', component: 'Text', text: 'Confirm' },
    {
      id: 'go',
      component: 'Button',
      child: 'go-label',
      action: { event: { name: 'confirm', context: { note: { path: '/note' } } } },
    },
    { id: 'root', component: 'Column', children: ['title', 'note', 'go'] },
  ];
}

export function updateComponentsMessage(surfaceId: string, components: unknown[]) {
  return { version: 'v0.9.1', updateComponents: { surfaceId, components } };
}

/** One field of a surface's latest snapshot. */
export async function surfaceField<K extends keyof InteractiveSurface>(
  harness: { snapshot: (surfaceId: string) => Promise<InteractiveSurface> },
  surfaceId: string,
  key: K,
): Promise<InteractiveSurface[K]> {
  const surface = await harness.snapshot(surfaceId);
  return surface[key];
}
