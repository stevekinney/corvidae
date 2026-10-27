// Type-level tripwire (COR-1703, COR-1704, COR-1705, COR-1706, COR-1707): the flat review, schedule, session, and run methods and the members
// that moved onto `bureau.internals` must not return to `Bureau`'s top level. If this file stops
// compiling, a member that belongs behind `reviews`, `schedules`, `contexts`, `tasks`, or `internals` was declared on
// `Bureau` again.

import type { BureauMemberPath } from './http/operation-map.ts';
import type {
  Bureau,
  BureauAudit,
  BureauContexts,
  BureauTasks,
  BureauInternals,
  BureauReviews,
  BureauSchedules,
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
  'getRun' | 'subscribeRunSnapshot' | 'getDurableRun' | 'waitForDurableRun' | 'listDurableRuns'
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
    | 'taskRegistry',
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

// `contexts` has exactly the eleven operations.
export type ContextsMembers = AssertNever<
  Exclude<
    keyof BureauContexts,
    | 'list'
    | 'get'
    | 'delete'
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
