import type { OperationFault } from './operation-fault.ts';

type StaleRevisionData = Extract<OperationFault, { code: 'StaleRevision' }>['data'];

// `currentRevision` is what distinguishes `StaleRevision` from a plain
// `Conflict`, so a fault that omits it does not compile.
export const withCurrentRevision: StaleRevisionData = { currentRevision: 5 };
export const withBothRevisions: StaleRevisionData = { expectedRevision: 3, currentRevision: 'r5' };
// @ts-expect-error `currentRevision` is required on a `StaleRevision` fault.
export const withoutCurrentRevision: StaleRevisionData = { expectedRevision: 3 };
// @ts-expect-error an empty payload is not a `StaleRevision` fault.
export const empty: StaleRevisionData = {};
