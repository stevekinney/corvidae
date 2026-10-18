import { describe } from 'bun:test';

import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import { registerEvidenceContractTests } from './evidence-projection-contract-harness-evidence';
import { registerProjectionContractTests } from './evidence-projection-contract-harness-projection';
import { registerSupersessionContractTests } from './evidence-projection-contract-harness-supersession';
import { registerTenantIsolationContractTests } from './evidence-projection-contract-harness-tenant-isolation';

export interface RunEvidenceProjectionStorageContractOptions {
  /** Human-readable backend label, used in the `describe` block title. */
  label: string;
  /** Factory that returns a fresh, empty backend for each test. */
  makeBackend: () => EvidenceProjectionStorage;
}

/**
 * The single shared {@link EvidenceProjectionStorage} contract suite. Invoke it
 * once per backend so every backend clears byte-identical assertions: evidence
 * immutability, supersession, projection revision discipline, the correction
 * flow, and tenant isolation. Backend-specific concerns (key families, restart,
 * capacity) live in the backend's own test file.
 */
export function runEvidenceProjectionStorageContract(
  options: RunEvidenceProjectionStorageContractOptions,
): void {
  describe(`EvidenceProjectionStorage contract (${options.label})`, () => {
    registerEvidenceContractTests(options);
    registerSupersessionContractTests(options);
    registerProjectionContractTests(options);
    registerTenantIsolationContractTests(options);
  });
}
