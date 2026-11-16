/**
 * The version 1 snapshots of the vector store that the code on main wrote (COR-2184), as a test
 * reads them: `fixtures/vector-store-version-1.json` holds, per scenario, every key under the vector
 * store's prefix and the text main stored under it. The file is never edited by hand.
 */
import type { Storage } from '@lostgradient/storage';

interface Version1Fixtures {
  /** The commit whose encoder wrote the snapshots. */
  readonly generatedFrom: string;
  /** The key prefix of the vector store the snapshots were taken under. */
  readonly prefix: string;
  /** Each scenario's keys and the text main stored under them. */
  readonly scenarios: Record<string, Record<string, string>>;
}

export const version1 = (await Bun.file(
  new URL('./fixtures/vector-store-version-1.json', import.meta.url),
).json()) as Version1Fixtures;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The keys and text main stored for `name`. */
export function version1Scenario(name: string): Record<string, string> {
  const entries = version1.scenarios[name];
  if (entries === undefined) throw new Error(`No version 1 snapshot is named ${name}.`);
  return entries;
}

/** Replaces everything `storage` holds under the vector store's prefix with main's bytes for `name`. */
export async function seedVersion1(storage: Storage, name: string): Promise<void> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(version1.prefix)) keys.push(key);
  for (const key of keys) await storage.delete(key);
  for (const [key, text] of Object.entries(version1Scenario(name))) {
    await storage.put(key, encoder.encode(text));
  }
}

/** Every key under the vector store's prefix and its text, in key order. */
export async function snapshotVectorStore(storage: Storage): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan(version1.prefix)) {
    entries.push([key, decoder.decode(value)]);
  }
  return Object.fromEntries(entries.toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

/**
 * `storage`, with each `conditionalBatch` handed to `intercept`, which decides whether and when
 * `run` (the real swap) happens: to hold it, to fail it, or to change what it read first.
 */
export function intercepting(
  storage: Storage,
  intercept: (run: () => Promise<boolean>) => Promise<boolean>,
): Storage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'conditionalBatch') {
        return (...parameters: Parameters<NonNullable<Storage['conditionalBatch']>>) =>
          intercept(() => target.conditionalBatch!(...parameters));
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The text stored under `key`, or `undefined` when nothing is. */
export async function textAt(storage: Storage, key: string): Promise<string | undefined> {
  const bytes = await storage.get(key);
  return bytes === null ? undefined : decoder.decode(bytes);
}
