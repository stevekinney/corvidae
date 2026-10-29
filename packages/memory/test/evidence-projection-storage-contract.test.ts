import { MemoryStorage } from '@lostgradient/storage';

import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import { runEvidenceProjectionStorageContract } from './evidence-projection-contract-harness';

/**
 * Runs the single shared contract suite against both backends so each clears
 * byte-identical assertions. Backend-specific concerns (key families, restart,
 * capacity) live in each backend's own test file.
 */

runEvidenceProjectionStorageContract({
  label: 'in-memory',
  makeBackend: () => createInMemoryEvidenceProjectionStorage(),
});

runEvidenceProjectionStorageContract({
  label: 'weft',
  makeBackend: () => createWeftEvidenceProjectionStorage(new MemoryStorage()),
});
