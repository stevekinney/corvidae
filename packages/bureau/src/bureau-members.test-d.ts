// Type-level tripwire (COR-1703, COR-1704): the flat review and schedule methods and the members
// that moved onto `bureau.internals` must not return to `Bureau`'s top level. If this file stops
// compiling, a member that belongs behind `reviews`, `schedules`, or `internals` was declared on
// `Bureau` again.

import type { BureauMemberPath } from './http/operation-map.ts';
import type { Bureau, BureauInternals, BureauReviews, BureauSchedules } from './types.ts';

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
  | 'tasks'
>;

export type NoFlatReviewMembers = AssertNever<RemovedReviewMembers>;
export type NoFlatScheduleMembers = AssertNever<RemovedScheduleMembers>;
export type NothingMovedStaysOnBureau = AssertNever<MovedToInternals>;

// The replacements are declared, at the types the project document names.
export type ReviewsAreDeclared = Bureau['reviews'] extends BureauReviews ? true : never;
export type SchedulesAreDeclared = Bureau['schedules'] extends BureauSchedules ? true : never;
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

// A member path in the operation map names a member a Bureau has, through optional members and
// into `internals`, and refuses one it does not.
export const reviewsResolve: BureauMemberPath = 'reviews.resolve';
export const registryList: BureauMemberPath = 'internals.taskRegistry.list';
export const optionalWorkflows: BureauMemberPath = 'workflows.listRuns';
// @ts-expect-error -- `reviews` has no `nonexistent` member
export const missingReviewsMember: BureauMemberPath = 'reviews.nonexistent';
// @ts-expect-error -- the flat review method moved to `reviews`
export const flatReviewMethod: BureauMemberPath = 'resolveReview';
// @ts-expect-error -- the flat schedule method moved to `schedules`
export const flatScheduleMethod: BureauMemberPath = 'createSchedule';
export const schedulesCreate: BureauMemberPath = 'schedules.create';
