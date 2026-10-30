/**
 * Which in-process call each operation `createBureauHandler` serves delegates to (COR-1703).
 *
 * Every served operation is a row: either a `member` (a dotted path on a {@link Bureau}) or an
 * `exempt` reason, for the few that are transport-only or composed from several members. A row
 * names the call the operation is *about*, so a reader can find the in-process equivalent of a
 * wire operation and the other way round. `operation-map.test.ts` reads the handler's own
 * registry (`BUREAU_HANDLER_OPERATIONS`), so a newly served operation with no row fails it, and a
 * row naming an operation that is no longer served, or a member a Bureau does not have, fails it
 * too. The `satisfies` below makes a member path that is not on `Bureau` a compile error as well.
 *
 * Moving a namespace in-process (`tasks`, `contexts`, `schedules`, ...) is one edit per operation
 * here: change its `member` string to the new path.
 */
import type { Bureau } from '../types.ts';

/** Past this many segments a path is not a Bureau member any row names. */
type MaximumPathDepth = 3;

/**
 * Every dotted path to a callable or value member of `Type`, to {@link MaximumPathDepth}
 * segments, through optional members (a Bureau without assets has no `assets`, and the path still
 * names the member a Bureau with assets has). Functions end a path; their own properties are not
 * members.
 */
type MemberPath<
  Type,
  Depth extends readonly unknown[] = [],
> = Depth['length'] extends MaximumPathDepth
  ? never
  : NonNullable<Type> extends (...parameters: never[]) => unknown
    ? never
    : NonNullable<Type> extends object
      ? {
          [Key in keyof NonNullable<Type> & string]:
            Key | `${Key}.${MemberPath<NonNullable<Type>[Key], [...Depth, unknown]>}`;
        }[keyof NonNullable<Type> & string]
      : never;

/** A dotted path to a member of a {@link Bureau}, such as `reviews.resolve` or `contexts.get`. */
export type BureauMemberPath = MemberPath<Bureau>;

/** What one served operation delegates to. */
export type OperationBinding =
  | {
      /** The in-process member the operation delegates to, as a path on a Bureau. */
      readonly member: BureauMemberPath;
    }
  | {
      /** Why the operation has no in-process counterpart: it is transport-only or composed. */
      readonly exempt: string;
    };

/**
 * The served operations and the in-process member each delegates to. Operations of a namespace
 * that has not moved in-process yet name today's flat member; the issue that moves the namespace
 * changes the row.
 */
export const OPERATION_MAP = {
  'weft.system.principal': {
    exempt: 'the caller’s principal; read from the request, not a Bureau',
  },
  'bureau.deployment.get': { exempt: 'composed from the Bureau’s id, lifecycle, and agents' },
  'bureau.diagnostics.get': { member: 'internals.diagnostics' },
  'bureau.events': { exempt: 'a transport subscription over the Bureau’s event feed' },
  'operative.runs.events': { exempt: 'a transport subscription over a run’s event feed' },
  'bureau.agents.catalog': { exempt: 'composed from the catalog, the opt-ins, and the models' },

  'bureau.tasks.list': { member: 'tasks.list' },
  'bureau.tasks.get': { member: 'tasks.get' },
  'bureau.tasks.cancel': { member: 'tasks.cancel' },
  'bureau.tasks.inspect': { member: 'tasks.inspect' },
  'bureau.tasks.events': { member: 'tasks.events' },
  'bureau.tasks.respond': { member: 'tasks.respond' },

  'bureau.contexts.list': { member: 'contexts.list' },
  'bureau.contexts.get': { member: 'contexts.get' },
  'bureau.contexts.delete': { member: 'contexts.delete' },
  'bureau.contexts.input': { member: 'contexts.input' },
  'bureau.contexts.steer': { member: 'contexts.steer' },
  'bureau.contexts.fork': { member: 'contexts.fork' },
  'bureau.contexts.rename': { member: 'contexts.rename' },

  'bureau.reviews.list': { member: 'reviews.list' },
  'bureau.reviews.get': { member: 'reviews.get' },
  'bureau.reviews.resolve': { member: 'reviews.resolve' },

  'bureau.schedules.list': { member: 'schedules.list' },
  'bureau.schedules.get': { member: 'schedules.get' },
  'bureau.schedules.create': { member: 'schedules.create' },
  'bureau.schedules.pause': { member: 'schedules.pause' },
  'bureau.schedules.resume': { member: 'schedules.resume' },
  'bureau.schedules.cancel': { member: 'schedules.cancel' },
  'bureau.schedules.update': { member: 'schedules.update' },

  'bureau.goals.list': { member: 'goals.list' },
  'bureau.goals.get': { member: 'goals.get' },
  'bureau.goals.create': { member: 'goals.create' },
  'bureau.goals.cancel': { member: 'goals.cancel' },

  'bureau.workflows.create': { member: 'workflows.create' },
  'bureau.workflows.update': { member: 'workflows.update' },
  'bureau.workflows.pause': { member: 'workflows.pause' },
  'bureau.workflows.resume': { member: 'workflows.resume' },
  'bureau.workflows.delete': { member: 'workflows.delete' },
  'bureau.workflows.get': { member: 'workflows.get' },
  'bureau.workflows.list': { member: 'workflows.list' },
  'bureau.workflows.revisions': { member: 'workflows.revisions' },
  'bureau.workflows.runs.list': { member: 'workflows.listRuns' },
  'bureau.workflows.runs.get': { member: 'workflows.getRun' },
  'bureau.workflows.signal': { member: 'workflows.signal' },

  'bureau.memory.list': { member: 'memory.list' },
  'bureau.memory.search': { member: 'memory.search' },
  'bureau.memory.get': { member: 'memory.get' },
  'bureau.memory.forget': { member: 'memory.forget' },
  // `correct` stays composed in the handler over `forget` plus a write.
  'bureau.memory.correct': { member: 'memory.forget' },
  'bureau.memory.share': { member: 'memory.share' },
  'bureau.memory.share.revoke': { member: 'memory.revokeShare' },
  'bureau.memory.hold': { member: 'memory.placeLegalHold' },
  'bureau.memory.hold.release': { member: 'memory.releaseLegalHold' },
  'bureau.memory.quarantine': { member: 'memory.quarantine' },
  'bureau.memory.export': { member: 'memory.export' },

  'bureau.assets.get': { member: 'assets.inspect' },
  'bureau.assets.uploads.create': { member: 'assets.beginUpload' },
  'bureau.assets.uploads.append': { member: 'assets.appendUpload' },
  'bureau.assets.uploads.complete': { member: 'assets.admit' },
  'bureau.assets.uploads.abort': { member: 'assets.abortUpload' },

  'bureau.audit.query': { member: 'audit.query' },

  'bureau.decisions.decide': { member: 'decisions.decide' },

  'bureau.settings.get': { member: 'settings.get' },
  'bureau.settings.schema': { member: 'settings.schema' },
  'bureau.settings.update': { member: 'settings.update' },
  'bureau.settings.events': { member: 'settings.subscribe' },

  'bureau.agents.list': { member: 'agents.list' },
  // Describes one catalog agent against the models catalog (COR-1708).
  'bureau.agents.models': { member: 'agents.models' },
  'bureau.agents.definitions.create': { member: 'agents.create' },
  'bureau.agents.definitions.update': { member: 'agents.update' },
  'bureau.agents.definitions.delete': { member: 'agents.delete' },
  'bureau.agents.definitions.get': { member: 'agents.detail' },
  'bureau.agents.definitions.list': { member: 'agents.list' },
  'bureau.agents.definitions.revisions': { member: 'agents.revisions' },
  'bureau.agents.versions.list': { member: 'agents.versions.list' },
  'bureau.agents.versions.restore': { member: 'agents.versions.restore' },

  // COR-1813: the wire name is `rollback` because operation names are lowercase; the in-process
  // member keeps the camel-cased `rollBack`.
  'bureau.deployments.get': { member: 'deployments.get' },
  'bureau.deployments.ramp': { member: 'deployments.ramp' },
  'bureau.deployments.promote': { member: 'deployments.promote' },
  'bureau.deployments.rollback': { member: 'deployments.rollBack' },
} as const satisfies Readonly<Record<string, OperationBinding>>;
