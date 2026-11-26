import { MemoryStorage } from './index.ts';

/** Exercises the portable in-memory storage adapter. */
export async function runRuntimeSmoke(): Promise<void> {
  using storage = new MemoryStorage();
  await storage.put('portable', new TextEncoder().encode('storage'));
  if ((await storage.get('portable')) === null) throw new Error('Storage lost a written value.');
}
