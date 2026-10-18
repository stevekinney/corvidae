/**
 * Resolves {@link registryActivityContractHashes} for whichever registry
 * snapshot a contract-verification panel is showing (COR-162). The hasher is
 * asynchronous, so a panel reads `hashes` as `undefined` (still hashing) until
 * the current snapshot's hashes arrive, and never reads hashes computed for a
 * different snapshot.
 */
import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import {
  registryActivityContractHashes,
  type RegistryActivityHashes,
} from './contract-verification.ts';

export type RegistryActivityHashTracker = Readonly<{
  /** The current snapshot's expected activity hashes, once computed. */
  readonly hashes: RegistryActivityHashes | undefined;
  /** Why hashing the current snapshot failed, when it did. */
  readonly error: unknown;
}>;

type Settled =
  | Readonly<{ snapshot: RegistrySnapshotSource; hashes: RegistryActivityHashes }>
  | Readonly<{ snapshot: RegistrySnapshotSource; error: unknown }>;

/** Call during component initialisation; `read` returns the snapshot in view. */
export function trackRegistryActivityHashes(
  read: () => RegistrySnapshotSource | undefined,
): RegistryActivityHashTracker {
  let settled = $state.raw<Settled | undefined>();

  $effect(() => {
    const snapshot = read();
    if (snapshot === undefined) return;
    let current = true;
    const resolve = async (): Promise<void> => {
      let outcome: Settled;
      try {
        outcome = { snapshot, hashes: await registryActivityContractHashes(snapshot) };
      } catch (error: unknown) {
        outcome = { snapshot, error };
      }
      if (current) settled = outcome;
    };
    void resolve();
    return () => {
      current = false;
    };
  });

  const forCurrent = (): Settled | undefined => {
    const snapshot = read();
    return settled !== undefined && settled.snapshot === snapshot ? settled : undefined;
  };

  return {
    get hashes() {
      const entry = forCurrent();
      return entry !== undefined && 'hashes' in entry ? entry.hashes : undefined;
    },
    get error() {
      const entry = forCurrent();
      return entry !== undefined && 'error' in entry ? entry.error : null;
    },
  };
}
