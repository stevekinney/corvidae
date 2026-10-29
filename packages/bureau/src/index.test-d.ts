// Type-level tripwire (review finding, PRRT_kwDORvupsc6elgnL): the package
// barrel presents `AgentRunForName` and `BureauRunOptions` as exported named
// types in the public API, but `index.ts` used to omit both from its
// re-export lists — `AgentRunForName` from `./agent-catalog`, `BureauRunOptions`
// from `./types` — so a consumer naming either type had to reach past the
// barrel into an internal module path. `export type { X } from './module'`
// only fails to compile if `X` doesn't exist in `./module` at all — it does
// NOT fail if `X` exists but simply isn't re-exported from the barrel — so
// this file, which imports both ONLY from the barrel (`./index`), is the
// actual tripwire: it fails to compile if either re-export regresses.

import type {
  AgentRunForName,
  Bureau,
  BureauOptions,
  BureauFaultOperation,
  BureauFaultPlan,
  BureauFaultPlanEntry,
  BureauRunOptions,
  DurableEventHistoryFixture,
  DurableEventHistoryFixtureOptions,
  DurableEventHistoryFixtureRecord,
  RunCreationReceipt,
  RunCreationReceiptLocation,
} from './index';
import {
  BureauFaultSelectorResolutionError,
  BureauLedgerConflictError,
  COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS,
  createCommandLedger,
  createDurableEventHistoryFixture,
  createRunCreationLedger,
  digestCommandPayload,
  digestRunCreationPayload,
  DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE,
  RUN_CREATION_OPERATION_VERSION,
  RunCreationReceiptUnrecordedError,
  selectAuditWriteFaultTarget,
  selectWebhookDeliveryFaultTarget,
} from './index';
import type * as BureauEntry from './index';

declare const runOptions: BureauRunOptions;
declare const runResult: AgentRunForName<Record<string, never>, never>;
void runOptions;
void runResult;
void BureauFaultSelectorResolutionError;
void createDurableEventHistoryFixture;
void DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE;
void selectAuditWriteFaultTarget;
void selectWebhookDeliveryFaultTarget;

declare const faultOperation: BureauFaultOperation;
declare const faultPlan: BureauFaultPlan;
declare const faultEntry: BureauFaultPlanEntry;
declare const historyFixture: DurableEventHistoryFixture;
declare const historyOptions: DurableEventHistoryFixtureOptions;
declare const historyRecord: DurableEventHistoryFixtureRecord;
void faultOperation;
void faultPlan;
void faultEntry;
void historyFixture;
void historyOptions;
void historyRecord;

// COR-1695: members and options nothing outside Bureau's own tests used are
// gone. Each assertion fails to compile if its type declares any removed name.
type RemovedBureauMember =
  | 'updateSession'
  | 'querySession'
  | 'sessionVerbCapabilities'
  | 'getConfiguration'
  | 'getTools'
  | 'getRunReport'
  | 'deleteRun'
  | 'sweepExpiredReviews'
  | 'getRequestAuthorityValidator'
  | 'submitSchedulerTask'
  | 'locateSchedulerTask'
  | 'awaitSchedulerTask'
  | 'scheduler';
type RemovedBureauOption =
  | 'cache'
  | 'streaming'
  | 'scheduler'
  | 'persistence'
  | 'sessionPersistenceSleep'
  | 'shutdownTimeoutSleep'
  | 'sessionPersistenceRetryDelayMilliseconds'
  // COR-1701: the five retention windows now live under `retention`, and the two durable options
  // were renamed `durable` and `maintenance`.
  | 'auditRetention'
  | 'checkpointRetention'
  | 'eventRetention'
  | 'taskRetention'
  | 'runCreationTerminalRetentionMs'
  | 'durableExecution'
  | 'durableBackgroundTasks';
export const bureauDeclaresNoRemovedMember: [Extract<keyof Bureau, RemovedBureauMember>] extends [
  never,
]
  ? true
  : never = true;
export const bureauOptionsDeclareNoRemovedOption: [
  Extract<keyof BureauOptions, RemovedBureauOption>,
] extends [never]
  ? true
  : never = true;

// COR-424: the run-creation command ledger and its receipt are on the barrel,
// and `createRun` resolves with a summary that can carry the receipt.
void BureauLedgerConflictError;
void createCommandLedger;
void createRunCreationLedger;
void digestCommandPayload;
void digestRunCreationPayload;
void RUN_CREATION_OPERATION_VERSION;
void RunCreationReceiptUnrecordedError;
type StartedTask = Awaited<ReturnType<Bureau['tasks']['start']>>;
declare const startedTask: StartedTask;
export const startedTaskReceipt: RunCreationReceipt | undefined = startedTask.receipt;

// COR-424: the run-creation binding's retention window and its receipt query.
void COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS;
export const retentionOption: NonNullable<BureauOptions['retention']> = {
  receipts: { olderThan: 86_400_000 },
};
type LocateReturn424 = Awaited<ReturnType<Bureau['tasks']['receipt']>>;
declare const locatedReceipt: LocateReturn424;
export const receiptLocation: RunCreationReceiptLocation = locatedReceipt;

// COR-1769: Bureau's storage fixtures are test support for Bureau's own tests
// (`./test/storage-fixtures`), not part of the package entry. Each name must
// be absent from the barrel, as a value and as a type.
type RemovedStorageFixtureValue =
  'createLmdbStorageFixture' | 'createMemoryStorageFixture' | 'createSqliteStorageFixture';
export const entryExportsNoStorageFixtureValue: [
  Extract<keyof typeof BureauEntry, RemovedStorageFixtureValue>,
] extends [never]
  ? true
  : never = true;
// @ts-expect-error `BureauStorageFixture` is not exported from the package entry.
export type { BureauStorageFixture as RemovedBureauStorageFixture } from './index';
// @ts-expect-error `CreateLmdbStorageFixtureOptions` is not exported from the package entry.
export type { CreateLmdbStorageFixtureOptions as RemovedLmdbOptions } from './index';
// @ts-expect-error `CreateMemoryStorageFixtureOptions` is not exported from the package entry.
export type { CreateMemoryStorageFixtureOptions as RemovedMemoryOptions } from './index';
// @ts-expect-error `CreatePersistentStorageFixtureOptions` is not exported from the package entry.
export type { CreatePersistentStorageFixtureOptions as RemovedPersistentOptions } from './index';
// @ts-expect-error `PersistentBureauStorageFixture` is not exported from the package entry.
export type { PersistentBureauStorageFixture as RemovedPersistentFixture } from './index';

// COR-1795: the test harness and what reads one (the quiescence report and the
// reproduction artifact) are Bureau's own test support, because the harness
// takes a storage fixture the entry does not export. Each name must be absent
// from the barrel.
type RemovedHarnessValue =
  | 'assembleReproductionArtifact'
  | 'assertBureauQuiescent'
  | 'BureauHarnessUnsupportedError'
  | 'BureauQuiescenceError'
  | 'createBureauTestHarness'
  | 'locateWorkspaceRoot';
export const entryExportsNoHarnessValue: [
  Extract<keyof typeof BureauEntry, RemovedHarnessValue>,
] extends [never]
  ? true
  : never = true;
// @ts-expect-error `BureauTestHarness` is not exported from the package entry.
export type { BureauTestHarness as RemovedBureauTestHarness } from './index';
// @ts-expect-error `BureauQuiescenceReport` is not exported from the package entry.
export type { BureauQuiescenceReport as RemovedBureauQuiescenceReport } from './index';
// @ts-expect-error `ReproductionArtifact` is not exported from the package entry.
export type { ReproductionArtifact as RemovedReproductionArtifact } from './index';
