/**
 * `BureauOptions.storage` takes a Weft `Storage`, and Bureau builds its key-value view over it with
 * `textValueStore`. A test that injects faults, counts calls, or holds a read at the key-value level
 * keeps its key-value store and hands this adapter to Bureau: every call Bureau makes through the
 * `Storage` it receives lands on that store, at the key-value level the test already speaks.
 */
import {
  type BatchOperation,
  type ConditionalBatchCondition,
  matchesScanOptions,
  MemoryStorage,
  type ScanOptions,
  type Storage,
  type ConditionalTextValueStore,
} from '@lostgradient/weft';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A `Storage` whose every call is served by `store`. The adapter owns nothing: disposing it does not
 * close `store`. It reports the ephemeral capabilities of `MemoryStorage`, so a Bureau given it
 * composes no durable engine unless the test says so, and a durable engine cannot be built over it.
 */
export function storageOverTextStore(store: ConditionalTextValueStore): Storage {
  async function* keys(prefix: string, options?: ScanOptions): AsyncGenerator<string> {
    for (const key of await store.list(prefix)) {
      if (matchesScanOptions(key, options)) yield key;
    }
  }

  function textOperation(operation: BatchOperation) {
    return operation.type === 'put'
      ? ({ type: 'set', key: operation.key, value: decoder.decode(operation.value) } as const)
      : ({ type: 'delete', key: operation.key } as const);
  }

  return {
    capabilities: () => new MemoryStorage().capabilities(),
    async get(key) {
      const text = await store.get(key);
      return text === null ? null : encoder.encode(text);
    },
    async put(key, value) {
      await store.set(key, decoder.decode(value));
    },
    async delete(key) {
      await store.delete(key);
    },
    async *scan(prefix, options) {
      for await (const key of keys(prefix, options)) {
        const text = await store.get(key);
        if (text !== null) yield [key, encoder.encode(text)];
      }
    },
    async batch(operations) {
      for (const operation of operations) {
        if (operation.type === 'put')
          await store.set(operation.key, decoder.decode(operation.value));
        else await store.delete(operation.key);
      }
    },
    conditionalBatch(conditions: ConditionalBatchCondition[], operations: BatchOperation[]) {
      return store.conditionalBatch(
        conditions.map((condition) => ({
          key: condition.key,
          expectedValue:
            condition.expectedValue === null ? null : decoder.decode(condition.expectedValue),
        })),
        operations.map(textOperation),
      );
    },
    has: (key) => store.has(key),
    deletePrefix: (prefix) => store.deletePrefix(prefix),
    keys,
    [Symbol.dispose]() {},
  };
}
