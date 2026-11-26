import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createAgent } from './index.ts';

/** Loads Operative's portable root; provider smoke modules exercise provider construction separately. */
export async function runRuntimeSmoke(): Promise<void> {
  const storage = new MemoryStorage();
  const store = textValueStore(storage);
  await store.set('runtime-smoke', 'portable');
  if ((await store.get('runtime-smoke')) !== 'portable')
    throw new Error('MemoryStorage did not persist.');

  const agent = createAgent({
    generate: async () => ({ content: 'portable', toolCalls: [] }),
  });
  const result = await agent.run('Say portable.').result();
  if (result.finishReason !== 'stop-condition')
    throw new Error('Operative agent did not complete its inline generate turn.');
  await store.close();
}
