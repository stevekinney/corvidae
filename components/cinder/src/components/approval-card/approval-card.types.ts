import type { HTMLAttributes } from 'svelte/elements';

export type ApprovalToolRisk = 'low' | 'medium' | 'high';

/** Heading level rendered for the card title. Section headings render one level deeper. */
export type ApprovalCardHeadingLevel = 2 | 3 | 4 | 5 | 6;

/** @schemaObject */
export type ApprovalTool = {
  /** The tool's identifier, such as `issue-refund`. The `row` layout writes it small and monospaced. */
  name: string;
  /** The tool's human name, such as `Issue refund`, written before the identifier. Omit it when the surrounding rows already name the call. */
  label?: string;
  /** Risk level assigned by the policy evaluator. Read as Reads, Changes things or Dangerous in muted text; the glyph carries the alert. */
  risk: ApprovalToolRisk;
  /** True when the operation cannot be reversed. Adds "Can't be undone", which never breaks across lines. */
  irreversible?: boolean;
};

/** @schemaObject */
export type ApprovalSandbox = {
  /** Sandbox provider, such as Codex or a remote execution backend. */
  provider: string;
  /** Sandbox profile or policy name. */
  name: string;
  /** Working directory for the pending operation. */
  workingDir: string;
};

export type ApprovalOperationKind = 'command' | 'file-write' | 'patch' | 'other';

/** @schemaObject */
export type ApprovalCommandOperation = {
  /** Operation family being approved. */
  kind: 'command';
  /** Shell command for command approvals. */
  command: string;
  /** File paths that the operation may read or write. Duplicate paths are collapsed for display. */
  filesTouched?: string[];
  /**
   * JSON-like argument preview shown to the approver.
   *
   * @schemaPermissive
   */
  argsPreview?: unknown;
};

/** @schemaObject */
export type ApprovalFileWriteOperation = {
  /** Operation family being approved. */
  kind: 'file-write';
  /** File paths that the operation may read or write. File-write approvals require at least one path. Duplicate paths are collapsed for display. */
  filesTouched: string[];
  /**
   * JSON-like argument preview shown to the approver.
   *
   * @schemaPermissive
   */
  argsPreview?: unknown;
};

/** @schemaObject */
export type ApprovalPatchOperation = {
  /** Operation family being approved. */
  kind: 'patch';
  /** File paths that the operation may read or write. Duplicate paths are collapsed for display. */
  filesTouched?: string[];
  /**
   * JSON-like argument preview shown to the approver.
   *
   * @schemaPermissive
   */
  argsPreview?: unknown;
  /** Patch diff for patch approvals. */
  diff: string;
};

/** @schemaObject */
export type ApprovalOtherOperation = {
  /** Operation family being approved. */
  kind: 'other';
  /** File paths that the operation may read or write. Duplicate paths are collapsed for display. */
  filesTouched?: string[];
  /**
   * JSON-like argument preview shown to the approver.
   *
   * @schemaPermissive
   */
  argsPreview?: unknown;
};

export type ApprovalOperation =
  | ApprovalCommandOperation
  | ApprovalFileWriteOperation
  | ApprovalPatchOperation
  | ApprovalOtherOperation;

export type ApprovalOperationSchema = ApprovalOperation;

/**
 * Where an approval stands. `unavailable` is a held approval nobody can answer right now, such
 * as one that belongs to an agent whose plugin is disabled; it shows a neutral word and
 * `unavailableReason`, and no Deny or Approve.
 */
export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'approved_with_edits'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'unavailable';

export type ApprovalResolutionDecision = 'approve' | 'approve_with_edits' | 'deny' | 'cancel';

/** @schemaObject */
export type ApprovalResolution = {
  /** Decision selected by the approver. */
  decision: ApprovalResolutionDecision;
  /**
   * Parsed JSON arguments when the approver accepts edited arguments.
   *
   * @schemaPermissive
   */
  editedArgs?: unknown;
  /** The approver's note, saved with the decision. When the decision is Deny, the agent reads it as the reason. */
  reason?: string;
  /** Whether the approver asked the host to remember this approval boundary. */
  remember: boolean;
};

/**
 * Layout of an approval. `card` is the full review surface; `row` is the shared approval row
 * (glyph and question, a line naming the tool and where it came from, the consequence, Input,
 * Add a note, Deny and Approve) for an approval inside a transcript or beneath a tool call.
 */
export type ApprovalCardLayout = 'card' | 'row';

export type ApprovalCardCallbacks = {
  /** Called for approve, approve-with-edits, and deny with the complete resolution payload. */
  onResolve?: (resolution: ApprovalResolution) => void;
};

/** Props for the ApprovalCard component. */
export type ApprovalCardProps = Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> &
  ApprovalCardCallbacks & {
    /** Tool requesting approval. */
    tool: ApprovalTool;
    /** Optional sandbox context in which the operation will run. */
    sandbox?: ApprovalSandbox;
    /** Operation details shown to the approver. */
    operation: ApprovalOperation;
    /** Environment variable names only. Values are ignored if accidentally supplied as `NAME=value`. */
    env?: string[];
    /** Snapshot identifier for the pending approval context. */
    snapshotId?: string;
    /** Policy version that produced the approval request. */
    policyVersion: string;
    /** Idempotency key that makes repeated decisions durable. */
    idempotencyKey: string;
    /** Optional ISO timestamp after which a pending approval is treated as expired. */
    expiresAt?: string;
    /** Persisted approval state. */
    state: ApprovalState;
    /** Whether approving with edited JSON arguments is available. Default `false`. */
    editableArgs?: boolean;
    /** Heading level for the card title; section headings render one level deeper. Default `3`. */
    headingLevel?: ApprovalCardHeadingLevel;
    /** Layout: the full `card`, or the shared `row`, one approval inside a transcript or beneath a tool call. Default `'card'`. */
    layout?: ApprovalCardLayout;
    /** The question the approval asks, such as `Refund order 4471 for $42.00?`. Default `Run <tool>?`. */
    question?: string;
    /** Who asked, written after "Approval from": `Tool runner`, or `the agent`. */
    source?: string;
    /** When the approval was asked. Written as relative time ("4 min ago") while the approval is pending. */
    requestedAt?: string | number | Date;
    /** What approving does, in one line, such as `Sends $42.00 back to the original card`. */
    consequence?: string;
    /**
     * Offers "Allow <tool> for <scope>" as a checkbox on its own line before Deny and Approve, with
     * the scope written after "for", such as `the rest of this chat`. Leave it out for a tool set to
     * Always, which never offers it. Checking it sets `remember` on the resolution.
     */
    rememberScope?: string;
    /** Who decided, once the approval is decided: `you`. Written as "Denied by you". */
    decidedBy?: string;
    /** When the approval was decided, written as a time of day after the outcome ("Denied by you · 10:40 AM"). */
    decidedAt?: string | number | Date;
    /** Why Deny and Approve are off while the approval is still pending, such as `Approving is off until Interborough is reachable`. Written above the actions and named by both buttons. */
    disabledReason?: string;
    /** Why an `unavailable` approval cannot be answered now, written beneath it. */
    unavailableReason?: string;
    /** The reference time for relative times. Defaults to now. */
    now?: Date | number;
    /** Additional CSS classes applied to the root element. */
    class?: string;
  };

/**
 * Cinder-specific schema surface for ApprovalCard.
 *
 * The resolution callback is documented but marked unsupported because
 * functions cannot be represented as JSON Schema controls.
 */
export type ApprovalCardSchemaProps = {
  /** Tool requesting approval. */
  tool: ApprovalTool;
  /** Optional sandbox context in which the operation will run. */
  sandbox?: ApprovalSandbox;
  /** Operation details shown to the approver. */
  operation: ApprovalOperationSchema;
  /** Environment variable names only. Values are ignored if accidentally supplied as `NAME=value`. */
  env?: string[];
  /** Snapshot identifier for the pending approval context. */
  snapshotId?: string;
  /** Policy version that produced the approval request. */
  policyVersion: string;
  /** Idempotency key that makes repeated decisions durable. */
  idempotencyKey: string;
  /** Optional ISO timestamp after which a pending approval is treated as expired. */
  expiresAt?: string;
  /** Persisted approval state. */
  state: ApprovalState;
  /** Whether approving with edited JSON arguments is available. Default `false`. @default false */
  editableArgs?: boolean;
  /** Heading level for the card title; section headings render one level deeper. Default `3`. @default 3 */
  headingLevel?: ApprovalCardHeadingLevel;
  /** Layout: the full `card`, or the shared `row`, one approval inside a transcript or beneath a tool call. Default `'card'`. @default 'card' */
  layout?: ApprovalCardLayout;
  /** The question the approval asks, such as `Refund order 4471 for $42.00?`. Default `Run <tool>?`. */
  question?: string;
  /** Who asked, written after "Approval from": `Tool runner`, or `the agent`. */
  source?: string;
  /** When the approval was asked, as an ISO timestamp. Written as relative time ("4 min ago") while the approval is pending. */
  requestedAt?: string;
  /** What approving does, in one line, such as `Sends $42.00 back to the original card`. */
  consequence?: string;
  /** Offers "Allow <tool> for <scope>" as a checkbox on its own line before Deny and Approve, with the scope written after "for", such as `the rest of this chat`. Leave it out for a tool set to Always. */
  rememberScope?: string;
  /** Who decided, once the approval is decided: `you`. Written as "Denied by you". */
  decidedBy?: string;
  /** When the approval was decided, as an ISO timestamp, written as a time of day after the outcome. */
  decidedAt?: string;
  /** Why Deny and Approve are off while the approval is still pending. Written above the actions and named by both buttons. */
  disabledReason?: string;
  /** Why an `unavailable` approval cannot be answered now, written beneath it. */
  unavailableReason?: string;
  /** Called for approve, approve-with-edits, and deny with the complete resolution payload. */
  onResolve?: (resolution: ApprovalResolution) => void;
  /** Additional CSS classes applied to the root element. */
  class?: string;
};
