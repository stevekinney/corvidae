// Type-level tripwire (COR-1703, COR-1704, COR-1705, COR-1706, COR-1707, COR-1708): the flat review, schedule, session, and run methods and the members
// that moved onto `bureau.internals` must not return to `Bureau`'s top level. If this file stops
// compiling, a member that belongs behind `reviews`, `schedules`, `contexts`, `tasks`, or `internals` was declared on
// `Bureau` again.

import { createAgent, createMockGenerate } from '@lostgradient/operative';
import { z } from 'zod';

import type { AgentModels } from './agent-models.ts';
import type { BureauDecisions } from './decisions/types.ts';
import type { BureauSettings } from './settings/types.ts';
import type { BureauMemberPath } from './http/operation-map.ts';
import type {
  Bureau,
  BureauAudit,
  BureauContexts,
  BureauTasks,
  BureauInternals,
  BureauRecoveryReport,
  BureauReviews,
  BureauSchedules,
  StartTaskOptions,
  TaskHandle,
} from './types.ts';

/** Compiles only when `Value` is `never`, so a member that returned names itself in the error. */
type AssertNever<Value extends never> = Value;

/** The flat review methods that `bureau.reviews` replaced. */
type RemovedReviewMembers = Extract<
  keyof Bureau,
  'listPendingReviews' | 'getReview' | 'resolveReview' | 'pendingHumanWaitsOfRun'
>;

/** The flat schedule members that `bureau.schedules` replaced. */
type RemovedScheduleMembers = Extract<
  keyof Bureau,
  | 'createSchedule'
  | 'getSchedule'
  | 'listSchedules'
  | 'pauseSchedule'
  | 'resumeSchedule'
  | 'cancelSchedule'
  | 'updateSchedule'
  | 'getScheduleAgentName'
  | 'getScheduleInputPreview'
>;

/** The flat session methods that `bureau.contexts` replaced. */
type RemovedSessionMembers = Extract<
  keyof Bureau,
  | 'listSessions'
  | 'getSession'
  | 'deleteSession'
  | 'signalSession'
  | 'submitSessionInput'
  | 'sessionInputsDeliveredBy'
  | 'submitSteeringCommand'
  | 'getSessionSteering'
  | 'forkSession'
>;

/** The members that moved onto `bureau.internals`, by their old top-level names. */
type MovedToInternals = Extract<
  keyof Bureau,
  | 'eventFeed'
  | 'runEventFeeds'
  | 'kv'
  | 'sessionStore'
  | 'store'
  | 'hasExplicitId'
  | 'hasDurableEngine'
  | 'taskRetention'
  | 'webhookNotifier'
  | 'onlineEvalSampler'
  | 'auditTrail'
  | 'listAbortingRuns'
  | 'whenRunRecorded'
>;

// COR-1707: the run members merged into `tasks`.
type RemovedTaskMembers = Extract<
  keyof Bureau,
  | 'getRun'
  | 'subscribeRunSnapshot'
  | 'getDurableRun'
  | 'waitForDurableRun'
  | 'listDurableRuns'
  | 'locateRunCreationReceipt'
  | 'eventHistory'
  | 'subscribeEventHistory'
  | 'createRun'
  | 'listRuns'
  | 'abortRun'
  | 'cancelDurableRun'
  | 'run'
>;

export type NoFlatReviewMembers = AssertNever<RemovedReviewMembers>;
export type NoFlatTaskMembers = AssertNever<RemovedTaskMembers>;
export type NoFlatScheduleMembers = AssertNever<RemovedScheduleMembers>;
export type NoFlatSessionMembers = AssertNever<RemovedSessionMembers>;
export type NothingMovedStaysOnBureau = AssertNever<MovedToInternals>;
// `auditTrail` is reachable only as `internals.auditTrail`; `bureau.audit.query` reads it redacted.
export type NoTopLevelAuditTrail = AssertNever<Extract<keyof Bureau, 'auditTrail'>>;

// The replacements are declared, at the types the project document names.
export type ReviewsAreDeclared = Bureau['reviews'] extends BureauReviews ? true : never;
export type SchedulesAreDeclared = Bureau['schedules'] extends BureauSchedules ? true : never;
export type ContextsAreDeclared = Bureau['contexts'] extends BureauContexts ? true : never;
// `tasks` is the task API now; the registry it named before is `internals.taskRegistry`.
export type TasksAreDeclared = Bureau['tasks'] extends BureauTasks ? true : never;
export type AuditIsDeclared = Bureau['audit'] extends BureauAudit ? true : never;
export type InternalsAreDeclared = Bureau['internals'] extends BureauInternals ? true : never;

// `internals` carries every moved member under its new name.
export type InternalsMembers = AssertNever<
  Exclude<
    | 'eventFeed'
    | 'runEventFeeds'
    | 'kv'
    | 'sessionStore'
    | 'store'
    | 'hasExplicitId'
    | 'hasDurableEngine'
    | 'taskRetention'
    | 'webhookNotifier'
    | 'onlineEvalSampler'
    | 'auditTrail'
    | 'abortingTasks'
    | 'whenTaskRecorded'
    | 'taskRegistry'
    | 'diagnostics',
    keyof BureauInternals
  >
>;

// `reviews` has exactly the four operations.
export type ReviewsMembers = AssertNever<
  Exclude<keyof BureauReviews, 'list' | 'get' | 'resolve' | 'pendingOf'>
>;

// `schedules` has exactly the eleven operations.
export type SchedulesMembers = AssertNever<
  Exclude<
    keyof BureauSchedules,
    | 'create'
    | 'get'
    | 'list'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'update'
    | 'agentName'
    | 'inputPreview'
    | 'events'
    | 'subscribeEvents'
  >
>;

// `contexts` has exactly the twelve operations.
export type ContextsMembers = AssertNever<
  Exclude<
    keyof BureauContexts,
    | 'list'
    | 'get'
    | 'delete'
    | 'rename'
    | 'signal'
    | 'input'
    | 'inputsDeliveredBy'
    | 'steer'
    | 'steering'
    | 'fork'
    | 'events'
    | 'subscribeEvents'
  >
>;

// `audit` has exactly the one operation.
export type AuditMembers = AssertNever<Exclude<keyof BureauAudit, 'query'>>;

// A member path in the operation map names a member a Bureau has, through optional members and
// into `internals`, and refuses one it does not.
export const reviewsResolve: BureauMemberPath = 'reviews.resolve';
export const registryList: BureauMemberPath = 'internals.taskRegistry.list';
export const auditQuery: BureauMemberPath = 'audit.query';
export const optionalWorkflows: BureauMemberPath = 'workflows.listRuns';
// @ts-expect-error -- `reviews` has no `nonexistent` member
export const missingReviewsMember: BureauMemberPath = 'reviews.nonexistent';
// @ts-expect-error -- the flat review method moved to `reviews`
export const flatReviewMethod: BureauMemberPath = 'resolveReview';
// @ts-expect-error -- the flat schedule method moved to `schedules`
export const flatScheduleMethod: BureauMemberPath = 'createSchedule';
export const schedulesCreate: BureauMemberPath = 'schedules.create';
export const contextsGet: BureauMemberPath = 'contexts.get';
// @ts-expect-error -- the flat session method moved to `contexts`
export const flatSessionMethod: BureauMemberPath = 'getSession';

// COR-1707: a start has no per-request override of what an agent's definition decides.
export type NoPerRequestAgentCaps = AssertNever<
  Extract<keyof StartTaskOptions, 'systemPrompt' | 'maximumSteps' | 'maximumTokens'>
>;

// `tasks` declares the operations the project document names, `respond` and `inspect` (the
// handler's operations, moved in-process) among them.
export type TasksMembers = AssertNever<
  Exclude<
    | 'start'
    | 'detail'
    | 'get'
    | 'list'
    | 'cancel'
    | 'receipt'
    | 'workflow'
    | 'workflows'
    | 'wait'
    | 'snapshot'
    | 'events'
    | 'subscribeEvents'
    | 'inspect'
    | 'respond',
    keyof BureauTasks
  >
>;

// `tasks.start` resolves to a `TaskHandle` typed by the catalog entry's output, and to an untyped
// one for a name known only at run time.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compiles only when `Value` is `true`, so an `Equals` that is `false` fails here. */
type AssertTrue<Value extends true> = Value;

const researcher = createAgent({
  generate: createMockGenerate([]),
  name: 'researcher',
  output: z.object({ answer: z.string() }),
});
declare const typedBureau: Bureau<{ readonly researcher: typeof researcher }>;
declare const runtimeName: string;
const typedStart = typedBureau.tasks.start('researcher', 'x');
export type TypedStartIsATypedHandle = AssertTrue<
  Equals<typeof typedStart, Promise<TaskHandle<{ answer: string }>>>
>;
const stringStart = typedBureau.tasks.start(runtimeName, 'x');
export type StringStartIsAnUntypedHandle = AssertTrue<
  Equals<typeof stringStart, Promise<TaskHandle>>
>;

// COR-1708: the Bureau's top-level members, fixed as an exact set. Adding a member, or removing
// one, fails here and nowhere else, so a flat method cannot return and a namespace cannot lose an
// entry unnoticed. The list is the project document's table of top-level members (Bureau API, DX,
// and architecture, "The in-process surface"). COR-1709 added `decisions` and COR-1710 `settings`.
// `runtimeServices` and `peerCalls` are members the
// table does not mention and this issue does not change.
type TopLevelMembers =
  // Namespaces.
  | 'tasks'
  | 'contexts'
  | 'reviews'
  | 'schedules'
  | 'models'
  | 'decisions'
  | 'settings'
  | 'audit'
  | 'internals'
  | 'agents'
  | 'workflows'
  | 'children'
  | 'goals'
  | 'memory'
  | 'assets'
  | 'surfaces'
  // The renamed top-level operations.
  | 'ownerOf'
  | 'recovery'
  | 'maintain'
  | 'frames'
  // The members that did not change.
  | 'id'
  | 'durableEngine'
  | 'lifecycle'
  | 'shutdown'
  | 'dispose'
  | 'setRequestAuthorityValidator'
  | 'addEventListener'
  | 'removeEventListener'
  | 'on'
  | 'once'
  | 'subscribe'
  | 'toObservable'
  | 'events'
  | 'complete'
  | 'completed'
  | 'signal'
  | 'runtimeServices'
  | 'peerCalls';

export type BureauTopLevelMembersAreExact = AssertTrue<Equals<keyof Bureau, TopLevelMembers>>;

// The renamed operations keep their signatures, and the old names are gone.
export type NoOldTopLevelNames = AssertNever<
  Extract<
    keyof Bureau,
    'waitForRecovery' | 'subscribeLiveFrames' | 'getOwner' | 'runDurableMaintenance'
  >
>;
export type RecoveryIsAlwaysPresent = AssertTrue<
  Equals<Bureau['recovery'], () => Promise<BureauRecoveryReport>>
>;
export type MaintainTakesAnOptionalClock = AssertTrue<
  Equals<Bureau['maintain'], (now?: number) => Promise<true | undefined>>
>;

// `agents.models(name)` describes one agent, or nothing for a name no agent has.
export type AgentsModelsDescribesOneAgent = AssertTrue<
  Equals<Bureau['agents']['models'], (name: string) => AgentModels | undefined>
>;

// COR-1709: `decisions` is declared, with the one operation, and a `boolean` request answers a `boolean`.
export type DecisionsAreDeclared = AssertTrue<Equals<Bureau['decisions'], BureauDecisions>>;
export type DecisionsMembers = AssertNever<Exclude<keyof BureauDecisions, 'decide'>>;
declare const decideBureau: Bureau;
const booleanDecision = decideBureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });
const choiceDecision = decideBureau.decisions.decide({
  kind: 'choice',
  question: 'Which?',
  options: [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
  ],
});
export type BooleanDecisionIsABoolean = AssertTrue<
  Equals<Awaited<typeof booleanDecision>['value'], boolean>
>;
export type ChoiceDecisionIsAKey = AssertTrue<
  Equals<Awaited<typeof choiceDecision>['value'], string>
>;

// COR-1710: `settings` is declared, with its four operations.
export type SettingsAreDeclared = AssertTrue<Equals<Bureau['settings'], BureauSettings>>;
export type SettingsMembers = AssertTrue<
  Equals<keyof BureauSettings, 'get' | 'schema' | 'update' | 'subscribe'>
>;
