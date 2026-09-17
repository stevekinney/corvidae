import type { Storage } from '@repo/weft';
import type { StorageBackend } from './types.ts';

/**
 * Creates a storage instance based on the selected backend and database path.
 *
 * Uses dynamic imports so that native addons are only loaded when requested.
 */
export async function createStorage(backend: StorageBackend, database: string): Promise<Storage> {
  switch (backend) {
    case 'sqlite': {
      const { BunSQLiteStorage } = await import('@repo/weft');
      return new BunSQLiteStorage(database);
    }
    case 'lmdb': {
      const { LMDBStorage } = await import('@repo/weft');
      return new LMDBStorage(database);
    }
    case 'memory':
      return createMemoryStorage();
    default: {
      const exhaustiveCheck: never = backend;
      throw new Error(`Unknown storage backend: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function createMemoryStorage(): Promise<Storage> {
  const { MemoryStorage } = await import('@repo/weft');
  return new MemoryStorage();
}
