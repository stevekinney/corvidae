import { MemoryStorage } from '../memory.ts';
import { describeConditionalBatch } from './conditional-batch.test-support.ts';

describeConditionalBatch({
  name: 'MemoryStorage',
  factory: () => {
    const storage = new MemoryStorage();
    return { storage, cleanup: () => storage[Symbol.dispose]() };
  },
});
