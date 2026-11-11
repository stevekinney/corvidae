/**
 * The core context of `buildRuntimeComposition` (COR-2376): one object, built once the storage,
 * durable engine, memory, skills and toolboxes exist, that every seam factory in this directory
 * reads. A plain member is a value fixed before the core exists; an accessor reads the
 * `buildRuntimeComposition` binding it names when it is called, so a value the returned
 * composition reassigns later is read live.
 *
 * A seam is `create<Seam>(core, peers)`: synchronous, side-effect free, and called once, in the
 * seam block of `buildRuntimeComposition`, directly after the core. The engine is live before the
 * core exists (it reclaims runs from inside `createRunEngine`), so nothing above the seam block may
 * reach a seam member except through `resolveRunServices`, which waits on the composition's
 * readiness gate first (COR-1509, COR-1586).
 */
import type {
  BureauChildInvariants,
  GenerateFunction,
  SessionStore,
} from '@lostgradient/operative';
import type { ConditionalTextValueStore, Storage } from '@lostgradient/storage';
import type { RuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import type { GovernedMemory } from '@lostgradient/memory';
import type { createWorkflowLogStore } from '@lostgradient/weft';
import type {
  BureauToolbox,
  CatalogAgentRunOptionsResolver,
  DurableComposition,
  RuntimeCompositionDependencies,
  RuntimeCompositionOptions,
  ScheduleFireEventMap,
} from '../runtime-composition-types';
import type { CatalogRunRecoveryRecord } from '../catalog-run-recovery-record';
import type { DiagnosticSink } from '../types';
import type { SecretAnswerStore } from '../secret-answers';
import type { SkillCatalogRevision, SkillEventMap } from '../skills';
import type { StorageFence } from '../storage-fence';
import type { createRunAuthorityValidator } from '../run-authority.ts';

/** What every seam factory reads from `buildRuntimeComposition`. */
export interface CompositionCore {
  // Plain members: fixed before the core literal, so a factory may destructure them.

  /** The options the composition was built from. */
  readonly options: RuntimeCompositionOptions;
  /** The default dependencies, overlaid with the ones the caller supplied. */
  readonly dependencies: RuntimeCompositionDependencies;
  /** The step limit of a run that names none. */
  readonly maximumSteps: number;
  /** The system prompt of a run that names none. */
  readonly systemPrompt: RuntimeCompositionOptions['systemPrompt'];
  /** Reports a diagnostic to the host. */
  readonly diagnose: DiagnosticSink;
  /** The clock, timers and identifiers of this composition. */
  readonly runtimeServices: RuntimeServices;
  /** COR-1586: opens when the catalog run-options resolver is wired or abandoned. */
  readonly catalogResolverGate: PromiseWithResolvers<void>;
  /** AB-10: runs the engine flagged as version-mismatched during boot recovery. */
  readonly workflowVersionMismatches: Map<
    string,
    { storedVersion: string; registeredVersion: string }
  >;
  /** COR-1916: recovered runs whose services could not be rebuilt. */
  readonly unrebuildableRecoveredRuns: Set<string>;
  /** AB-223: run id to schedule id, for each scheduled fire this composition built services for. */
  readonly scheduledFireScheduleIds: Map<string, string>;
  /** AB-241: the catalog recovery records read during one boot recovery pass. */
  readonly catalogRunRecoveryCache: Map<string, CatalogRunRecoveryRecord>;
  /** The terminal events of scheduled fires. */
  readonly scheduleFireEvents: TypedEventTarget<ScheduleFireEventMap>;
  /** The skill events of this composition. */
  readonly skillEvents: TypedEventTarget<SkillEventMap>;
  /** The caller's storage adapter, which the composition never disposes. */
  readonly effectiveStorage: RuntimeCompositionOptions['storage'];
  /** The fence every use of the caller's storage goes through. */
  readonly storageFence: StorageFence | undefined;
  /** The fenced raw storage the durable engine and the text-value view share. */
  readonly durableStorage: Storage | undefined;
  /** The text-value view of the fenced storage. */
  readonly kv: ConditionalTextValueStore | undefined;
  /** The durable engine and its checkpoint store, when durable execution is on. */
  readonly durable: DurableComposition | undefined;
  /** Whether the caller's storage keeps its data across a restart. */
  readonly effectiveStorageIsPersistent: boolean;
  /** The observability options of the composition. */
  readonly effectiveObservability: RuntimeCompositionOptions['observability'];
  /** COR-1811: persisted `ctx.log` lines, for a durable composition only. */
  readonly logStore: ReturnType<typeof createWorkflowLogStore> | undefined;
  /** The governed memory of the composition. */
  readonly memory: GovernedMemory | undefined;
  /** COR-1546: the tenant a run's memory is partitioned under. */
  readonly memoryTenantId: () => string;
  /** The skill catalog revision a run's skills come from. */
  readonly skillCatalog: SkillCatalogRevision | undefined;
  /** The session store, when the composition has storage. */
  readonly sessionStore: SessionStore | undefined;
  /** COR-1920: the store of sealed secret answers. */
  readonly secretAnswers: SecretAnswerStore | undefined;
  /** The toolbox every run starts from. */
  readonly baseToolbox: BureauToolbox;
  /** The toolbox of a run that has no other. */
  readonly fallbackToolbox: BureauToolbox;
  /** The configured `generate`, with its cache applied. */
  readonly configuredGenerate: GenerateFunction | undefined;
  /** COR-2106: what a Bureau-owned run hands the children it dispatches. */
  readonly bureauChildInvariants: BureauChildInvariants;

  // Read-only accessors: `let`s the returned composition reassigns, read live.

  /** Whether every dependency the resolver reads is initialized. */
  readonly compositionOpen: boolean;
  /** The validator of a run's request authority. */
  readonly requestAuthorityValidator: ReturnType<typeof createRunAuthorityValidator>;
  /** AB-240: the catalog agent's run-options resolver, once `createBureau` wires it. */
  readonly catalogAgentRunOptionsResolver: CatalogAgentRunOptionsResolver | undefined;
  /** COR-1586: whether `catalogResolverGate` has opened. */
  readonly catalogResolverGateOpen: boolean;
  /** COR-1586: why the catalog run-options resolver was abandoned, when it was. */
  readonly catalogResolverAbandonedReason: string | undefined;
}
