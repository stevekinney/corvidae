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
  AssembleReproductionArtifactOptions,
  Bureau,
  BureauOptions,
  BureauFaultOperation,
  BureauFaultPlan,
  BureauFaultPlanEntry,
  BureauHarnessCapability,
  BureauIncompleteWork,
  BureauQuiescenceReport,
  BureauRunOptions,
  BureauStorageFixture,
  BureauTestHarness,
  BureauTestHarnessOptions,
  CreateLmdbStorageFixtureOptions,
  CreateMemoryStorageFixtureOptions,
  CreatePersistentStorageFixtureOptions,
  DurableEventHistoryFixture,
  DurableEventHistoryFixtureOptions,
  DurableEventHistoryFixtureRecord,
  DurableRunRegistration,
  ReproductionArtifact,
  ReproductionArtifactEnvironment,
  RunCreationReceipt,
  RunCreationReceiptLocation,
} from './index';
import {
  assembleReproductionArtifact,
  assertBureauQuiescent,
  BureauFaultSelectorResolutionError,
  BureauHarnessUnsupportedError,
  BureauLedgerConflictError,
  COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS,
  createBureauTestHarness,
  createCommandLedger,
  createDurableEventHistoryFixture,
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createRunCreationLedger,
  createSqliteStorageFixture,
  digestCommandPayload,
  digestRunCreationPayload,
  DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE,
  locateWorkspaceRoot,
  RUN_CREATION_OPERATION_VERSION,
  RunCreationReceiptUnrecordedError,
  selectAuditWriteFaultTarget,
  selectWebhookDeliveryFaultTarget,
} from './index';

declare const runOptions: BureauRunOptions;
declare const runResult: AgentRunForName<Record<string, never>, never>;
void runOptions;
void runResult;
void assembleReproductionArtifact;
void assertBureauQuiescent;
void BureauFaultSelectorResolutionError;
void BureauHarnessUnsupportedError;
void createBureauTestHarness;
void createDurableEventHistoryFixture;
void createLmdbStorageFixture;
void createMemoryStorageFixture;
void createSqliteStorageFixture;
void DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE;
void locateWorkspaceRoot;
void selectAuditWriteFaultTarget;
void selectWebhookDeliveryFaultTarget;

declare const artifactOptions: AssembleReproductionArtifactOptions;
declare const artifactEnvironment: ReproductionArtifactEnvironment;
declare const artifact: ReproductionArtifact;
declare const capability: BureauHarnessCapability;
declare const faultOperation: BureauFaultOperation;
declare const faultPlan: BureauFaultPlan;
declare const faultEntry: BureauFaultPlanEntry;
declare const incompleteWork: BureauIncompleteWork;
declare const quiescenceReport: BureauQuiescenceReport;
declare const storageFixture: BureauStorageFixture;
declare const harness: BureauTestHarness;
declare const harnessOptions: BureauTestHarnessOptions;
declare const persistentOptions: CreatePersistentStorageFixtureOptions;
declare const lmdbOptions: CreateLmdbStorageFixtureOptions;
declare const memoryOptions: CreateMemoryStorageFixtureOptions;
declare const historyFixture: DurableEventHistoryFixture;
declare const historyOptions: DurableEventHistoryFixtureOptions;
declare const historyRecord: DurableEventHistoryFixtureRecord;
declare const runRegistration: DurableRunRegistration;
void artifactOptions;
void artifactEnvironment;
void artifact;
void capability;
void faultOperation;
void faultPlan;
void faultEntry;
void incompleteWork;
void quiescenceReport;
void storageFixture;
void harness;
void harnessOptions;
void persistentOptions;
void lmdbOptions;
void memoryOptions;
void historyFixture;
void historyOptions;
void historyRecord;
void runRegistration;

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
