/**
 * COR-1631 — the wire types of Bureau's interactive-surface contract,
 * `bureau.interactive-surface.v1`. `documentation/interactive-surface.md` is
 * the contract; these types are its TypeScript form, and every shape here is a
 * one-way door once a consumer depends on it. See that document's Design
 * section before changing any of them.
 */
import type { CleanupAcknowledgement } from '@lostgradient/operative';

/** The contract version every surface, command, and receipt carries. */
export const INTERACTIVE_SURFACE_CONTRACT_VERSION = 'bureau.interactive-surface.v1';

/** The contract version string, as a type. */
export type InteractiveSurfaceContractVersion = typeof INTERACTIVE_SURFACE_CONTRACT_VERSION;

/** The A2UI specification release an `a2ui` surface is pinned to. */
export const INTERACTIVE_SURFACE_A2UI_VERSION = 'v0.9.1';

/** The MIME type of an MCP Apps HTML resource. */
export const INTERACTIVE_SURFACE_MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The default cap on a surface's content, in UTF-8 bytes of its JSON: its
 * representation, data, summary, and action catalog together. It equals the
 * default `maxRequestBodyBytes` of `createBureauHandler`, so a surface that
 * fits the cap fits in one request.
 */
export const INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES = 1_048_576;

/** A JSON value, as a surface's data model and action values carry it. */
export type InteractiveSurfaceJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly InteractiveSurfaceJsonValue[]
  | { readonly [key: string]: InteractiveSurfaceJsonValue };

/** A JSON object, as a surface's schemas and A2UI components are written. */
export type InteractiveSurfaceJsonObject = { readonly [key: string]: InteractiveSurfaceJsonValue };

// ── Representations ─────────────────────────────────────────────────

/**
 * The native kind every host must render: a form for a JSON Schema 2020-12
 * object schema (Cinder's `SchemaForm` in `@lostgradient/chat`).
 */
export interface InteractiveSurfaceInputForm {
  readonly kind: 'input-form';
  /** The JSON Schema 2020-12 schema the form renders and an answer must satisfy. */
  readonly schema: InteractiveSurfaceJsonObject;
  /** The label of the form's submit control, when the default will not do. */
  readonly submitLabel?: string | undefined;
}

/** An A2UI v0.9.1 surface (experimental). */
export interface InteractiveSurfaceA2ui {
  readonly kind: 'a2ui';
  /** The A2UI release the components are written against. */
  readonly specificationVersion: typeof INTERACTIVE_SURFACE_A2UI_VERSION;
  /** The catalog the components come from, as A2UI's `createSurface` names it. */
  readonly catalogId: string;
  /**
   * The whole component list, as the adapter has folded A2UI's incremental
   * `updateComponents` messages into it. It may be empty after `createSurface`
   * and need not hold `root` yet, since components may arrive before it.
   */
  readonly components: readonly InteractiveSurfaceJsonObject[];
  /** Theme parameters for the catalog's `theme` schema. */
  readonly theme?: InteractiveSurfaceJsonObject | undefined;
  /** A2UI's `createSurface` flag asking the client to send its whole data model back. */
  readonly sendDataModel?: boolean | undefined;
}

/** The content security policy of an MCP App, as MCP Apps declares it. */
export interface InteractiveSurfaceMcpAppCsp {
  /** Origins the app may connect to. */
  readonly connectDomains: readonly string[];
  /** Origins the app may load scripts, styles, images, and fonts from. */
  readonly resourceDomains: readonly string[];
  /** Origins the app may embed in frames. */
  readonly frameDomains?: readonly string[] | undefined;
  /** Origins the app's document may use as its base URI. */
  readonly baseUriDomains?: readonly string[] | undefined;
}

/** The browser permissions an MCP App asks for; each absent one is denied. */
export interface InteractiveSurfaceMcpAppPermissions {
  readonly camera?: boolean | undefined;
  readonly microphone?: boolean | undefined;
  readonly geolocation?: boolean | undefined;
  readonly clipboardWrite?: boolean | undefined;
}

/** An MCP App: a `ui://` HTML resource the host renders in its sandbox. */
export interface InteractiveSurfaceMcpApp {
  readonly kind: 'mcp-app';
  /** The app's resource, a `ui://` URI. */
  readonly resourceUri: string;
  readonly mimeType: typeof INTERACTIVE_SURFACE_MCP_APP_MIME_TYPE;
  /** `sha256:` and the lowercase hex SHA-256 of the resource's bytes. */
  readonly contentDigest: string;
  /**
   * Which instance of the app this revision is. A new instance (a reloaded
   * resource, a new digest) gets a new id; an action from any other instance
   * is stale.
   */
  readonly instanceId: string;
  readonly csp: InteractiveSurfaceMcpAppCsp;
  readonly permissions: InteractiveSurfaceMcpAppPermissions;
  /** The tool whose result the app presents, when it is linked to one. */
  readonly toolName?: string | undefined;
  /** MCP Apps' `domain`: the dedicated sandbox origin the resource asks its host for. */
  readonly domain?: string | undefined;
  /** MCP Apps' `prefersBorder`: whether the app asks its host to draw a border around it. */
  readonly prefersBorder?: boolean | undefined;
}

/** What a surface shows: a closed union, grown only by a new contract version. */
export type InteractiveSurfaceRepresentation =
  InteractiveSurfaceInputForm | InteractiveSurfaceA2ui | InteractiveSurfaceMcpApp;

/** The kind of a surface's representation. */
export type InteractiveSurfaceKind = InteractiveSurfaceRepresentation['kind'];

// ── Actions ─────────────────────────────────────────────────────────

/** What an action does to its task. These are the only four. */
export type InteractiveSurfaceActionIntent = 'answer' | 'submit' | 'approve' | 'deny';

/**
 * How an admitted action continues its task: through the review it decides
 * (`reviews.resolve`), or through the signal it sends the task's session
 * (`signalSession`). `approve` and `deny` decide a review. `answer` and
 * `submit` send a signal, or answer a held `human-wait` review with the
 * action's value as its payload, which is how a run with no session is answered.
 */
export type InteractiveSurfaceContinuation =
  | {
      readonly type: 'review';
      readonly reviewId: string;
      /**
       * The approval round the surface shows. A re-gated tool approval keeps
       * its id and advances its round, so the adapter refuses an admission
       * whose round is no longer the review's current one.
       */
      readonly round?: number | undefined;
    }
  | { readonly type: 'signal'; readonly sessionId: string; readonly signalName: string };

/** One action a surface offers. */
export interface InteractiveSurfaceActionDefinition {
  /** Unique on the surface; what an action request names. */
  readonly name: string;
  readonly intent: InteractiveSurfaceActionIntent;
  readonly continuation: InteractiveSurfaceContinuation;
  /**
   * The JSON Schema 2020-12 schema the action's value must satisfy. Omitted
   * on an `input-form` surface's `answer` or `submit` action, the form's own
   * schema applies; omitted elsewhere, the action takes no value.
   */
  readonly valueSchema?: InteractiveSurfaceJsonObject | undefined;
  /** A label for the action's control. */
  readonly label?: string | undefined;
}

// ── The resource ────────────────────────────────────────────────────

/**
 * How a surface's content is classified. A `sensitive` surface's action
 * values never enter the durable history; the history records their digest.
 */
export type InteractiveSurfaceClassification = 'standard' | 'sensitive';

/** Why a surface closed. */
export type InteractiveSurfaceCloseReason = 'completed' | 'dismissed' | 'cancelled' | 'task-ended';

/** How a surface ended. */
export interface InteractiveSurfaceCloseResult {
  readonly reason: InteractiveSurfaceCloseReason;
  /** When it closed (ISO 8601). */
  readonly closedAt: string;
}

/**
 * Whether a surface can change. `live` while it is open; `frozen` once its
 * task was cancelled or ended, with its last revision still readable;
 * `torn-down` once it was closed explicitly, with its content gone.
 */
export type InteractiveSurfaceLiveness = 'live' | 'frozen' | 'torn-down';

/** An interactive surface, as a snapshot reads it. */
export interface InteractiveSurface {
  readonly contractVersion: InteractiveSurfaceContractVersion;
  /** Unique within its task. */
  readonly surfaceId: string;
  /** The task (agent run) the surface belongs to, and the only task its actions continue. */
  readonly taskId: string;
  /** The task's owner of record, who may read, change, and act on the surface. */
  readonly owner: string;
  /** Other principals who may read the surface and act on it, but not change it. */
  readonly audience: readonly string[];
  readonly kind: InteractiveSurfaceKind;
  /** What the surface shows; `null` once it is torn down. */
  readonly representation: InteractiveSurfaceRepresentation | null;
  /** The surface's data model (an A2UI data model, a form's initial value); `null` for none. */
  readonly data: InteractiveSurfaceJsonValue;
  /** The text a host that cannot render the kind shows instead. Never empty. */
  readonly summary: string;
  readonly actions: readonly InteractiveSurfaceActionDefinition[];
  readonly classification: InteractiveSurfaceClassification;
  /** Rises by one with every committed change. */
  readonly revision: number;
  /** The revision at which the representation (components, form, or app) last changed. */
  readonly componentRevision: number;
  /** The revision at which `data` last changed. */
  readonly dataRevision: number;
  readonly state: 'open' | 'closed';
  readonly liveness: InteractiveSurfaceLiveness;
  readonly closeResult: InteractiveSurfaceCloseResult | null;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601. */
  readonly updatedAt: string;
  /**
   * The cursor, in the task's durable history, of the event that committed
   * this revision; replaying from it yields every later change. `null` when
   * the history could not say (see the contract's Event durability section).
   */
  readonly eventCursor: string | null;
}

/**
 * Who is asking. Every field is optional: a caller that states none is
 * trusted (Bureau's own code), and each stated field narrows what it may do.
 */
export interface InteractiveSurfaceAuthorization {
  /** The authenticated principal. */
  readonly principal?: string | undefined;
  /** The task the caller acts within, when the caller is a run (a model's tool call). */
  readonly taskId?: string | undefined;
  /** The MCP App instance the request comes from. */
  readonly instanceId?: string | undefined;
}

// ── Commands ────────────────────────────────────────────────────────

/** The fields every command carries. */
export interface InteractiveSurfaceCommandBase {
  readonly contractVersion: InteractiveSurfaceContractVersion;
  /**
   * The caller's idempotency key. An exact retry (same id, same content)
   * returns the original receipt; the same id with other content is rejected.
   */
  readonly commandId: string;
  readonly taskId: string;
}

/** Creates a surface on a task. */
export interface CreateInteractiveSurfaceCommand extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.create';
  readonly surfaceId: string;
  readonly summary: string;
  readonly representation: InteractiveSurfaceRepresentation;
  readonly data?: InteractiveSurfaceJsonValue | undefined;
  readonly actions: readonly InteractiveSurfaceActionDefinition[];
  readonly audience?: readonly string[] | undefined;
  readonly classification?: InteractiveSurfaceClassification | undefined;
}

/**
 * Changes a surface, by compare-and-swap: it commits only while the surface's
 * `revision` is still `baseRevision`. Every field it omits keeps its value.
 */
export interface UpdateInteractiveSurfaceCommand extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.update';
  readonly surfaceId: string;
  readonly baseRevision: number;
  /** A new representation of the same kind. */
  readonly representation?: InteractiveSurfaceRepresentation | undefined;
  readonly data?: InteractiveSurfaceJsonValue | undefined;
  readonly summary?: string | undefined;
  readonly actions?: readonly InteractiveSurfaceActionDefinition[] | undefined;
}

/** Reads a surface's latest revision. A query: it carries no `commandId`. */
export interface InteractiveSurfaceSnapshotQuery {
  readonly type: 'surface.snapshot';
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly taskId: string;
  readonly surfaceId: string;
}

/** A renderer's request to take one of a surface's actions. */
export interface InteractiveSurfaceActionRequest extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.action';
  readonly surfaceId: string;
  /** The revision the renderer showed when the user acted. */
  readonly revision: number;
  /** The action's `name` in the surface's catalog. */
  readonly action: string;
  readonly value?: InteractiveSurfaceJsonValue | undefined;
  /** A2UI's `sourceComponentId`: the component that raised the action. Recorded with it. */
  readonly sourceComponentId?: string | undefined;
  /** A2UI's `timestamp`: when the user acted, as an ISO 8601 date-time. Recorded with it. */
  readonly timestamp?: string | undefined;
}

/**
 * What became of an admitted action once its continuation ran. Defined in
 * v1; Bureau does not accept it yet (see the contract).
 */
export interface InteractiveSurfaceActionResultCommand extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.action-result';
  readonly surfaceId: string;
  /** The `commandId` of the admitted action request. */
  readonly actionCommandId: string;
  readonly outcome: 'continued' | 'failed';
  readonly detail?: string | undefined;
}

/**
 * State a client reports back to a surface, such as an A2UI client's data
 * model. Defined in v1; Bureau does not accept it yet (see the contract).
 */
export interface InteractiveSurfaceContextUpdateCommand extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.context-update';
  readonly surfaceId: string;
  readonly revision: number;
  readonly data: InteractiveSurfaceJsonValue;
}

/**
 * Follows a surface's changes from a cursor in the task's durable history.
 * Defined in v1; Bureau does not serve it yet (see the contract).
 */
export interface InteractiveSurfaceSubscribeCommand {
  readonly type: 'surface.subscribe';
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly taskId: string;
  readonly surfaceId: string;
  /** The exclusive cursor to replay from; omitted, delivery starts with the latest revision. */
  readonly since?: string | undefined;
}

/**
 * Closes a surface and tears it down, only while its `revision` is still
 * `baseRevision`, so a close cannot discard a change its caller has not seen.
 */
export interface CloseInteractiveSurfaceCommand extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.close';
  readonly surfaceId: string;
  readonly baseRevision: number;
  readonly reason: Extract<InteractiveSurfaceCloseReason, 'completed' | 'dismissed'>;
}

/**
 * The owner's abort of a task's surfaces: every open surface of the task
 * freezes, closed as `cancelled`. Bureau issues it itself when the task is
 * cancelled.
 */
export interface AbortInteractiveSurfacesCommand extends InteractiveSurfaceCommandBase {
  readonly type: 'surface.owner-abort';
}

/** Asks whether every surface of a task has been frozen or closed. A query. */
export interface InteractiveSurfaceCleanupQuery {
  readonly type: 'surface.cleanup';
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly taskId: string;
}

/** Every command and query in the contract. */
export type InteractiveSurfaceCommand =
  | CreateInteractiveSurfaceCommand
  | UpdateInteractiveSurfaceCommand
  | InteractiveSurfaceSnapshotQuery
  | InteractiveSurfaceActionRequest
  | InteractiveSurfaceActionResultCommand
  | InteractiveSurfaceContextUpdateCommand
  | InteractiveSurfaceSubscribeCommand
  | CloseInteractiveSurfaceCommand
  | AbortInteractiveSurfacesCommand
  | InteractiveSurfaceCleanupQuery;

// ── Receipts ────────────────────────────────────────────────────────

/** Why a command was refused. Nothing was committed. */
export type InteractiveSurfaceRejectionReason =
  /** The command is malformed, or its content fails validation. */
  | 'invalid'
  /** No such task or surface, or the caller may not see it: the two are not told apart. */
  | 'not-found'
  /** A create for a surface that exists, or a reused `commandId` with other content. */
  | 'conflict'
  /** `baseRevision` (or an action's `revision`) is not the surface's revision. */
  | 'stale-revision'
  /** An action from an MCP App instance the surface no longer shows. */
  | 'stale-instance'
  /** The surface is closed or frozen, or its task has ended. */
  | 'closed'
  /** The content exceeds the payload cap. */
  | 'payload-too-large'
  /** The surface kept changing while the command was checked. Nothing committed; retry it. */
  | 'contended'
  /** The Bureau keeps no durable history, so it has no surfaces. */
  | 'unsupported-capability';

/** A refused command. */
export interface InteractiveSurfaceRejection {
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly outcome: 'rejected';
  readonly reason: InteractiveSurfaceRejectionReason;
  /** A human-readable explanation, never a secret. */
  readonly detail?: string | undefined;
  /** The surface's revision now, on a `stale-revision` rejection. */
  readonly currentRevision?: number | undefined;
}

/** The receipt of a create, update, or close that committed. */
export interface InteractiveSurfaceAcceptance {
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly outcome: 'accepted';
  readonly commandId: string;
  /** The revision this command committed. On a replay, the original commit's revision. */
  readonly committedRevision: number;
  /**
   * The surface as it stands now: as the command left it, or, on a replay, as
   * later commands have left it since.
   */
  readonly surface: InteractiveSurface;
  /** `true` when this is an exact retry answered from the original commit. */
  readonly replayed: boolean;
}

/** What a create returns. */
export type CreateInteractiveSurfaceReceipt =
  InteractiveSurfaceAcceptance | InteractiveSurfaceRejection;

/** What an update returns. */
export type UpdateInteractiveSurfaceReceipt =
  InteractiveSurfaceAcceptance | InteractiveSurfaceRejection;

/** What a close returns. */
export type CloseInteractiveSurfaceReceipt =
  InteractiveSurfaceAcceptance | InteractiveSurfaceRejection;

/** What a snapshot returns. */
export type InteractiveSurfaceSnapshotReceipt =
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'found';
      readonly surface: InteractiveSurface;
    }
  | InteractiveSurfaceRejection;

/**
 * An admitted action: the caller continues the task with `continuation`,
 * passing `value`. Admission is recorded in the task's durable history; it
 * does not change the surface.
 */
export interface InteractiveSurfaceActionAdmission {
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly outcome: 'accepted';
  readonly commandId: string;
  readonly taskId: string;
  readonly surfaceId: string;
  /** The revision the action was admitted against. */
  readonly revision: number;
  readonly action: string;
  readonly intent: InteractiveSurfaceActionIntent;
  readonly continuation: InteractiveSurfaceContinuation;
  readonly value: InteractiveSurfaceJsonValue;
  readonly replayed: boolean;
}

/** What an action request returns. */
export type InteractiveSurfaceActionReceipt =
  InteractiveSurfaceActionAdmission | InteractiveSurfaceRejection;

/** What an action result would return (types only in v1). */
export type InteractiveSurfaceActionResultReceipt =
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'recorded';
      readonly commandId: string;
    }
  | InteractiveSurfaceRejection;

/** What a context update would return (types only in v1). */
export type InteractiveSurfaceContextUpdateReceipt =
  InteractiveSurfaceAcceptance | InteractiveSurfaceRejection;

/** What a subscription delivers (types only in v1): each committed revision, in order. */
export type InteractiveSurfaceSubscribeReceipt =
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'subscribed';
      /** The revision the subscription starts from. */
      readonly surface: InteractiveSurface;
    }
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'gap';
      /** The earliest cursor the history still holds. */
      readonly firstRetainedCursor: string;
    }
  | InteractiveSurfaceRejection;

/**
 * What an owner abort returns: how many surfaces this invocation froze, and the
 * cleanup evidence. An abort is idempotent by its effect and keeps no replay
 * record: a retry, with any `commandId`, freezes whatever is still open and
 * counts only that, so `frozen` is `0` once an earlier abort froze everything.
 * `cleanup` is the evidence a caller relies on.
 */
export type AbortInteractiveSurfacesReceipt =
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'accepted';
      readonly commandId: string;
      readonly frozen: number;
      readonly cleanup: CleanupAcknowledgement;
    }
  | InteractiveSurfaceRejection;

/**
 * What a cleanup query returns: `found` with `completed` once every surface
 * of the task is frozen or closed, or `not-required` for a task that has none;
 * `pending` while any is still open.
 */
export type InteractiveSurfaceCleanupReceipt =
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'found';
      readonly cleanup: CleanupAcknowledgement;
    }
  | {
      readonly contractVersion: InteractiveSurfaceContractVersion;
      readonly outcome: 'pending';
      /** How many of the task's surfaces are still open. */
      readonly open: number;
    }
  | InteractiveSurfaceRejection;
