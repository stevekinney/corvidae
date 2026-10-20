/**
 * The metadata key on the system row a run's memory recall appends (COR-41). Recalled memory is
 * evidence for the model, not part of the thread a person reads, so the AG-UI snapshot leaves the
 * row out (`http/ag-ui-messages.ts`): this is the one place the two modules agree on its name.
 */
export const MEMORY_EVIDENCE_METADATA_KEY = 'memoryEvidence';
