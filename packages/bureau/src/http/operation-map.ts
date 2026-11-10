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

/** Closed workspace resource/action categories, shared by dispatch and conformance inventory. */
export type WorkspaceOperationClass =
  | 'public-discovery'
  | 'member-shared-read'
  | 'administrator-shared'
  | 'private-owned'
  | 'explicit-share'
  | 'deployment-operator';

/** What one served operation delegates to. */
export type OperationBinding = { readonly workspaceClass: WorkspaceOperationClass } & (
  | {
      /** The in-process member the operation delegates to, as a path on a Bureau. */
      readonly member: BureauMemberPath;
    }
  | {
      /** Why the operation has no in-process counterpart: it is transport-only or composed. */
      readonly exempt: string;
    }
);

/**
 * The served operations and the in-process member each delegates to. Operations of a namespace
 * that has not moved in-process yet name today's flat member; the issue that moves the namespace
 * changes the row.
 */
export const OPERATION_MAP = {
  'weft.system.principal': {
    workspaceClass: 'private-owned',
    exempt: 'the caller’s principal; read from the request, not a Bureau',
  },
  'bureau.deployment.get': {
    workspaceClass: 'member-shared-read',
    exempt: 'composed from the Bureau’s id, lifecycle, and agents',
  },
  'bureau.diagnostics.get': {
    workspaceClass: 'deployment-operator',
    member: 'internals.diagnostics',
  },
  'bureau.health.attention': { workspaceClass: 'administrator-shared', member: 'attention' },
  'bureau.events': {
    workspaceClass: 'deployment-operator',
    exempt: 'a transport subscription over the Bureau’s event feed',
  },
  'bureau.events.catalog': {
    workspaceClass: 'member-shared-read',
    exempt: 'a static description of the published event kinds; it reads no Bureau state',
  },
  'bureau.events.format': { workspaceClass: 'member-shared-read', member: 'formatEvent' },
  'bureau.plugins.contributions': { workspaceClass: 'member-shared-read', member: 'plugins' },
  'bureau.guardrails.list': { workspaceClass: 'member-shared-read', member: 'plugins.guardrails' },
  'operative.runs.events': {
    workspaceClass: 'private-owned',
    exempt: 'a transport subscription over a run’s event feed',
  },
  'bureau.agents.catalog': {
    workspaceClass: 'member-shared-read',
    exempt: 'composed from the catalog, the opt-ins, and the models',
  },
  'bureau.skills.list': {
    workspaceClass: 'member-shared-read',
    exempt: 'the host discovers skills and decides their trust; the handler only reports it',
  },

  'bureau.tasks.list': { workspaceClass: 'private-owned', member: 'tasks.list' },
  'bureau.tasks.get': { workspaceClass: 'private-owned', member: 'tasks.get' },
  'bureau.tasks.cancel': { workspaceClass: 'private-owned', member: 'tasks.cancel' },
  'bureau.tasks.inspect': { workspaceClass: 'private-owned', member: 'tasks.inspect' },
  'bureau.tasks.events': { workspaceClass: 'private-owned', member: 'tasks.events' },
  'bureau.tasks.respond': { workspaceClass: 'private-owned', member: 'tasks.respond' },

  'bureau.contexts.list': { workspaceClass: 'private-owned', member: 'contexts.list' },
  'bureau.contexts.get': { workspaceClass: 'private-owned', member: 'contexts.get' },
  'bureau.contexts.delete': { workspaceClass: 'private-owned', member: 'contexts.delete' },
  'bureau.contexts.input': { workspaceClass: 'private-owned', member: 'contexts.input' },
  'bureau.contexts.retract': { workspaceClass: 'private-owned', member: 'contexts.retract' },
  'bureau.contexts.forgetgrants': {
    workspaceClass: 'private-owned',
    member: 'contexts.forgetGrants',
  },
  'bureau.contexts.steer': { workspaceClass: 'private-owned', member: 'contexts.steer' },
  'bureau.contexts.fork': { workspaceClass: 'private-owned', member: 'contexts.fork' },
  'bureau.contexts.rename': { workspaceClass: 'private-owned', member: 'contexts.rename' },
  'bureau.contexts.window': { workspaceClass: 'private-owned', member: 'contexts.window' },

  'bureau.reviews.list': { workspaceClass: 'private-owned', member: 'reviews.list' },
  'bureau.reviews.get': { workspaceClass: 'private-owned', member: 'reviews.get' },
  'bureau.reviews.resolve': { workspaceClass: 'private-owned', member: 'reviews.resolve' },

  'bureau.schedules.list': { workspaceClass: 'administrator-shared', member: 'schedules.list' },
  'bureau.schedules.get': { workspaceClass: 'administrator-shared', member: 'schedules.get' },
  'bureau.schedules.create': { workspaceClass: 'administrator-shared', member: 'schedules.create' },
  'bureau.schedules.pause': { workspaceClass: 'administrator-shared', member: 'schedules.pause' },
  'bureau.schedules.resume': { workspaceClass: 'administrator-shared', member: 'schedules.resume' },
  'bureau.schedules.cancel': { workspaceClass: 'administrator-shared', member: 'schedules.cancel' },
  'bureau.schedules.update': { workspaceClass: 'administrator-shared', member: 'schedules.update' },
  'bureau.schedules.skipnext': {
    workspaceClass: 'administrator-shared',
    member: 'schedules.skipNext',
  },
  'bureau.schedules.unskip': { workspaceClass: 'administrator-shared', member: 'schedules.unskip' },
  'bureau.schedules.runnow': { workspaceClass: 'private-owned', member: 'schedules.runNow' },
  'bureau.schedules.missed': { workspaceClass: 'private-owned', member: 'schedules.missed' },

  'bureau.goals.list': { workspaceClass: 'private-owned', member: 'goals.list' },
  'bureau.goals.get': { workspaceClass: 'private-owned', member: 'goals.get' },
  'bureau.goals.create': { workspaceClass: 'private-owned', member: 'goals.create' },
  'bureau.goals.cancel': { workspaceClass: 'private-owned', member: 'goals.cancel' },

  'bureau.workflows.create': { workspaceClass: 'administrator-shared', member: 'workflows.create' },
  'bureau.workflows.update': { workspaceClass: 'administrator-shared', member: 'workflows.update' },
  'bureau.workflows.validate': {
    workspaceClass: 'administrator-shared',
    member: 'workflows.validate',
  },
  'bureau.workflows.pause': { workspaceClass: 'administrator-shared', member: 'workflows.pause' },
  'bureau.workflows.resume': { workspaceClass: 'administrator-shared', member: 'workflows.resume' },
  'bureau.workflows.delete': { workspaceClass: 'administrator-shared', member: 'workflows.delete' },
  'bureau.workflows.get': { workspaceClass: 'member-shared-read', member: 'workflows.get' },
  'bureau.workflows.list': { workspaceClass: 'member-shared-read', member: 'workflows.list' },
  'bureau.workflows.revisions': {
    workspaceClass: 'member-shared-read',
    member: 'workflows.revisions',
  },
  'bureau.workflows.history': { workspaceClass: 'member-shared-read', member: 'workflows.history' },
  'bureau.workflows.impact': { workspaceClass: 'member-shared-read', member: 'workflows.impact' },
  'bureau.workflows.runs.list': { workspaceClass: 'private-owned', member: 'workflows.listRuns' },
  'bureau.workflows.runs.get': { workspaceClass: 'private-owned', member: 'workflows.getRun' },
  'bureau.workflows.runs.cancel': { workspaceClass: 'private-owned', member: 'workflows.cancel' },
  'bureau.workflows.runs.history': {
    workspaceClass: 'private-owned',
    member: 'workflows.historyRuns',
  },
  'bureau.workflows.start': { workspaceClass: 'member-shared-read', member: 'workflows.start' },
  'bureau.workflows.internal.get': {
    workspaceClass: 'deployment-operator',
    member: 'workflows.getCode',
  },
  'bureau.workflows.signal': { workspaceClass: 'private-owned', member: 'workflows.signal' },

  'bureau.memory.list': { workspaceClass: 'private-owned', member: 'memory.list' },
  'bureau.memory.search': { workspaceClass: 'private-owned', member: 'memory.search' },
  'bureau.memory.get': { workspaceClass: 'private-owned', member: 'memory.get' },
  'bureau.memory.remember': { workspaceClass: 'private-owned', member: 'memory.write' },
  'bureau.memory.forget': { workspaceClass: 'private-owned', member: 'memory.forget' },
  // `correct` stays composed in the handler over `forget` plus a write.
  'bureau.memory.correct': { workspaceClass: 'private-owned', member: 'memory.forget' },
  'bureau.memory.share': { workspaceClass: 'explicit-share', member: 'memory.share' },
  'bureau.memory.share.revoke': { workspaceClass: 'explicit-share', member: 'memory.revokeShare' },
  'bureau.memory.hold': { workspaceClass: 'private-owned', member: 'memory.placeLegalHold' },
  'bureau.memory.hold.release': {
    workspaceClass: 'private-owned',
    member: 'memory.releaseLegalHold',
  },
  'bureau.memory.quarantine': { workspaceClass: 'private-owned', member: 'memory.quarantine' },
  'bureau.memory.export': { workspaceClass: 'private-owned', member: 'memory.export' },

  'bureau.assets.get': { workspaceClass: 'explicit-share', member: 'assets.inspect' },
  'bureau.assets.uploads.create': { workspaceClass: 'private-owned', member: 'assets.beginUpload' },
  'bureau.assets.uploads.append': {
    workspaceClass: 'private-owned',
    member: 'assets.appendUpload',
  },
  'bureau.assets.uploads.complete': { workspaceClass: 'private-owned', member: 'assets.admit' },
  'bureau.assets.uploads.abort': { workspaceClass: 'private-owned', member: 'assets.abortUpload' },

  'bureau.audit.query': { workspaceClass: 'private-owned', member: 'audit.query' },

  'bureau.notifications.list': { workspaceClass: 'private-owned', member: 'notifications.list' },
  'bureau.notifications.markread': {
    workspaceClass: 'private-owned',
    member: 'notifications.markRead',
  },
  'bureau.notifications.dismiss': {
    workspaceClass: 'private-owned',
    member: 'notifications.dismiss',
  },

  'bureau.decisions.decide': { workspaceClass: 'deployment-operator', member: 'decisions.decide' },

  'bureau.settings.get': { workspaceClass: 'administrator-shared', member: 'settings.get' },
  'bureau.settings.schema': { workspaceClass: 'administrator-shared', member: 'settings.schema' },
  'bureau.settings.update': { workspaceClass: 'administrator-shared', member: 'settings.update' },
  'bureau.settings.events': {
    workspaceClass: 'administrator-shared',
    member: 'settings.subscribe',
  },

  'bureau.agents.list': { workspaceClass: 'member-shared-read', member: 'agents.list' },
  // Describes one catalog agent against the models catalog (COR-1708).
  'bureau.agents.models': { workspaceClass: 'member-shared-read', member: 'agents.models' },
  'bureau.agents.references': {
    workspaceClass: 'administrator-shared',
    exempt: 'composed from the catalog, the schedules, the workflow files, and the hooks',
  },
  'bureau.agents.try': { workspaceClass: 'administrator-shared', member: 'agents.try' },
  'bureau.agents.definitions.create': {
    workspaceClass: 'administrator-shared',
    member: 'agents.create',
  },
  'bureau.agents.definitions.update': {
    workspaceClass: 'administrator-shared',
    member: 'agents.update',
  },
  'bureau.agents.definitions.delete': {
    workspaceClass: 'administrator-shared',
    member: 'agents.delete',
  },
  'bureau.agents.definitions.duplicate': {
    workspaceClass: 'administrator-shared',
    member: 'agents.duplicate',
  },
  'bureau.agents.definitions.get': {
    workspaceClass: 'member-shared-read',
    member: 'agents.detail',
  },
  'bureau.agents.definitions.list': { workspaceClass: 'member-shared-read', member: 'agents.list' },
  'bureau.agents.definitions.revisions': {
    workspaceClass: 'member-shared-read',
    member: 'agents.revisions',
  },
  'bureau.agents.versions.list': {
    workspaceClass: 'member-shared-read',
    member: 'agents.versions.list',
  },
  'bureau.agents.versions.restore': {
    workspaceClass: 'administrator-shared',
    member: 'agents.versions.restore',
  },
  'bureau.agents.overrides.get': {
    workspaceClass: 'member-shared-read',
    member: 'agents.overrides.get',
  },
  'bureau.agents.overrides.update': {
    workspaceClass: 'administrator-shared',
    member: 'agents.overrides.save',
  },

  // COR-1813: the wire name is `rollback` because operation names are lowercase; the in-process
  // member keeps the camel-cased `rollBack`.
  'bureau.deployments.get': { workspaceClass: 'deployment-operator', member: 'deployments.get' },
  'bureau.deployments.ramp': { workspaceClass: 'deployment-operator', member: 'deployments.ramp' },
  'bureau.deployments.promote': {
    workspaceClass: 'deployment-operator',
    member: 'deployments.promote',
  },
  'bureau.deployments.rollback': {
    workspaceClass: 'deployment-operator',
    member: 'deployments.rollBack',
  },

  'bureau.hooks.create': { workspaceClass: 'administrator-shared', member: 'hooks.create' },
  'bureau.hooks.update': { workspaceClass: 'administrator-shared', member: 'hooks.update' },
  'bureau.hooks.secret.replace': {
    workspaceClass: 'deployment-operator',
    member: 'hooks.replaceSigningSecret',
  },
  'bureau.hooks.delete': { workspaceClass: 'administrator-shared', member: 'hooks.delete' },
  'bureau.hooks.get': { workspaceClass: 'administrator-shared', member: 'hooks.get' },
  'bureau.hooks.list': { workspaceClass: 'administrator-shared', member: 'hooks.list' },
  'bureau.hooks.test': { workspaceClass: 'administrator-shared', member: 'hooks.test' },
  'bureau.hooks.deliveries': { workspaceClass: 'deployment-operator', member: 'hooks.deliveries' },
} as const satisfies Readonly<Record<string, OperationBinding>>;
