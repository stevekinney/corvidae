import { registerDeletionContract } from './governed-contract-deletion';
import { registerDeletionResultContract } from './governed-contract-deletion-results';
import { registerDerivationContract } from './governed-contract-derivation';
import { registerDurabilityContract } from './governed-contract-durability';
import { registerIsolationContract } from './governed-contract-isolation';
import { registerPoisoningContract } from './governed-contract-poisoning';
import { registerRaceContract } from './governed-contract-races';
import { registerRetrievalContract } from './governed-contract-retrieval';
import { registerSharingContract } from './governed-contract-sharing';

/**
 * The two-principal, two-tenant black-box contract for governed memory, run
 * once over the in-memory record storage and once over the Weft-backed record
 * storage. Both share a Weft-backed governance ledger, which is what a restart
 * resumes deletion propagation from.
 */
for (const backend of ['in-memory', 'weft'] as const) {
  registerIsolationContract(backend);
  registerPoisoningContract(backend);
  registerSharingContract(backend);
  registerDeletionContract(backend);
  registerDeletionResultContract(backend);
  registerDurabilityContract(backend);
  registerRaceContract(backend);
  registerDerivationContract(backend);
  registerRetrievalContract(backend);
}
