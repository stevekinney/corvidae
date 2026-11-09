import type {
  DetectionResult,
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
} from 'armorer';

import type {
  BeforeToolExecutionHook,
  PrepareStepHook,
  ValidateResponseHook,
  ValidateToolResultHook,
} from '../types';

/**
 * `DetectorContext`, `DetectionResult`, `InputDetector`, `GuardrailTriggeredEvent`,
 * and `GuardrailProvenance` live in `armorer`'s guardrail detector pipeline —
 * the same pipeline reused by memory recall, ingested documents, and skill
 * resources so every surface that admits retrieved content into the model's
 * context runs through identical detection and confidence-gating logic.
 */
export type {
  DetectionResult,
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
};

/** What an input guardrail does when it trips; see {@link InputGuardrailOptions.action}. */
export type InputGuardrailAction = 'block' | 'warn' | 'sanitize' | 'tripwire';

/** What an output guardrail does when it trips; see {@link OutputGuardrailOptions.action}. */
export type OutputGuardrailAction = 'block' | 'warn' | 'redact' | 'tripwire';

/** What a tool-call guardrail does when it trips; see {@link ToolCallGuardrailOptions.action}. */
export type ToolCallGuardrailAction = 'block' | 'warn' | 'tripwire';

/**
 * A guardrail that takes its own action instead of its group's (COR-2104). Left out, `action` is
 * the group's, as for a bare guardrail.
 */
export interface GuardrailWithAction<T, A extends string> {
  /** The detector or validator. */
  readonly guardrail: T;
  /**
   * What it does when it trips, whatever its group's action and whatever
   * {@link GuardrailsOptions.mode} sets that action to.
   */
  readonly action?: A | undefined;
}

/**
 * One entry of a guardrail group: a bare guardrail, which takes the group's action, or one wrapped
 * with an action of its own.
 */
export type GuardrailEntry<T, A extends string> = T | GuardrailWithAction<T, A>;

/** An entry of {@link GuardrailsOptions.input}'s detectors. */
export type InputGuardrailEntry = GuardrailEntry<InputDetector, InputGuardrailAction>;

/** An entry of {@link GuardrailsOptions.output}'s validators. */
export type OutputGuardrailEntry = GuardrailEntry<OutputValidator, OutputGuardrailAction>;

/** Options for configuring input guardrails. */
export interface InputGuardrailOptions {
  detectors: InputDetector[];
  /**
   * `'tripwire'` throws a `GuardrailTripwireError` instead of substituting a
   * blocked response — it hard-halts the run rather than letting the loop
   * continue. See `GuardrailsOptions.mode`, which sets this for you.
   */
  action?: InputGuardrailAction | undefined;
  onTriggered?: ((event: GuardrailTriggeredEvent) => void) | undefined;
  mode?: ('parallel' | 'sequential') | undefined;
  /** Getter that returns the current session taint state. When provided, detectors receive the live value. */
  getSessionTainted?: (() => boolean) | undefined;
  /**
   * What to do with a media part whose resolved asset has no safety verdict
   * (`unknown`). A part the safety gate `flagged` is always refused. The
   * default `'allow'` admits unverified assets; `'block'` refuses them. Only a
   * part a `ContentSourceResolver` projected carries a safety state.
   */
  assetSafety?: AssetSafetyPolicy | undefined;
}

/**
 * What to do with a resolved asset the safety gates gave no verdict (`unknown`).
 * A flagged asset is always refused. The default `'allow'` admits unverified
 * assets; `'block'` refuses them.
 */
export interface AssetSafetyPolicy {
  unknown?: ('allow' | 'block') | undefined;
}

/** Context provided to output validators. */
export interface ValidatorContext {
  step: number;
  conversationLength: number;
  toolCallCount: number;
  /**
   * The conversation so far as one string, in order: what each message says, the text of a tool
   * result (its `content` and `parts`), and the bodies of attachments the step resolved. It is read
   * only when called, and reflects the conversation as the step started, so a validator that
   * checks a reply against what was said (grounding) pays for it, and one that does not, does not.
   * Absent when a caller builds the context itself.
   */
  conversationText?: (() => string) | undefined;
}

/** Result of running an output validator against model output. */
export interface ValidationResult {
  valid: boolean;
  category: string;
  confidence: number;
  detail?: string | undefined;
  redacted?: string | undefined;
}

/** An output validator that inspects model responses for policy violations. */
export interface OutputValidator {
  name: string;
  validate: (output: string, context: ValidatorContext) => Promise<ValidationResult>;
}

/** Event emitted when an output guardrail is triggered. */
export interface OutputGuardrailTriggeredEvent {
  validator: string;
  category: string;
  confidence: number;
  action: 'block' | 'warn' | 'redact' | 'tripwire';
  output: string;
  detail?: string | undefined;
}

/** Options for configuring output guardrails. */
export interface OutputGuardrailOptions {
  validators: OutputValidator[];
  /**
   * `'tripwire'` throws a `GuardrailTripwireError` instead of substituting a
   * blocked/redacted response — it hard-halts the run rather than letting the
   * loop continue. See `GuardrailsOptions.mode`, which sets this for you.
   */
  action?: OutputGuardrailAction | undefined;
  onTriggered?: ((event: OutputGuardrailTriggeredEvent) => void) | undefined;
  blockMessage?: string | undefined;
}

/**
 * The input group of {@link GuardrailsOptions}: {@link InputGuardrailOptions} whose detectors may
 * each carry an action of their own. `action` is the action of every bare detector, and of what
 * the guardrail finds without a detector (an unsafe or undecodable media part).
 */
export interface InputGuardrailGroupOptions extends Omit<InputGuardrailOptions, 'detectors'> {
  /** The detectors, each bare or with its own action. */
  detectors: readonly InputGuardrailEntry[];
}

/**
 * The output group of {@link GuardrailsOptions}: {@link OutputGuardrailOptions} whose validators may
 * each carry an action of their own. `action` is the action of every bare validator.
 */
export interface OutputGuardrailGroupOptions extends Omit<OutputGuardrailOptions, 'validators'> {
  /** The validators, each bare or with its own action. */
  validators: readonly OutputGuardrailEntry[];
}

/** The call a {@link ToolCallValidator} judges, before it runs. */
export interface ToolCallValidatorCall {
  /** The call's id, which its result is paired with. */
  readonly id: string;
  /** The name of the tool the model called. */
  readonly name: string;
  /** The arguments the model passed. */
  readonly arguments: unknown;
}

/** What a {@link ToolCallValidator} reads besides the call. */
export interface ToolCallValidatorContext {
  /** The run's step. */
  readonly step: number;
  /** How many messages the conversation holds. */
  readonly conversationLength: number;
  /** How many calls the step makes, this one included. */
  readonly toolCallCount: number;
  /** Whether the session is tainted. */
  readonly sessionTainted: boolean;
}

/** A {@link ToolCallValidator}'s verdict on one call. */
export interface ToolCallValidationResult {
  /** `false` when the call breaks the validator's rule. */
  readonly valid: boolean;
  /** What the rule is about, such as `refund-limit`. */
  readonly category: string;
  /** How sure the validator is, from 0 to 1. Among validators that refuse a call, the surest names it. */
  readonly confidence: number;
  /** Why, for the guardrail's own `onTriggered`; never shown to the model or on a run event. */
  readonly detail?: string | undefined;
}

/**
 * A guardrail on the tool calls a model makes (COR-2104): it reads each call's name and arguments
 * before the call runs, which an output validator, reading only the reply's text, never sees.
 */
export interface ToolCallValidator {
  /** Names the guardrail in a refusal, a run event and a tripwire. */
  readonly name: string;
  /** What it guards, for a listing. */
  readonly description?: string | undefined;
  /**
   * What it does when a call breaks its rule, whatever its group's action and mode: `block` drops
   * the call and answers it with a `GUARDRAIL_BLOCKED` result, `warn` lets it run and reports it,
   * and `tripwire` halts the run. Left out, it is the group's action.
   */
  readonly action?: ToolCallGuardrailAction | undefined;
  /**
   * Judges one call. A validator that throws or rejects is contained, as a detector is: it finds
   * nothing, and the call is judged by the other validators.
   */
  readonly validate: (
    call: ToolCallValidatorCall,
    context: ToolCallValidatorContext,
  ) => Promise<ToolCallValidationResult>;
}

/** Event emitted when a tool-call guardrail is triggered. */
export interface ToolCallGuardrailTriggeredEvent {
  /** The validator that decided. */
  validator: string;
  /** What it found, from its result. */
  category: string;
  /** How sure it was, from 0 to 1. */
  confidence: number;
  /** The action taken: the validator's own, or its group's. */
  action: ToolCallGuardrailAction;
  /** The call it judged. */
  call: ToolCallValidatorCall;
  /** The validator's own explanation, which can quote the call's arguments. */
  detail?: string | undefined;
}

/** Options for configuring tool-call guardrails. */
export interface ToolCallGuardrailOptions {
  /** The validators every call is judged by. */
  validators: readonly ToolCallValidator[];
  /**
   * The action of every validator that has none of its own. `'block'` (default) drops the call,
   * `'warn'` lets it run, and `'tripwire'` halts the run. {@link GuardrailsOptions.mode}
   * `'tripwire'` sets it to `'tripwire'`.
   */
  action?: ToolCallGuardrailAction | undefined;
  /** Called once for each call a validator refuses, with the action taken. */
  onTriggered?: ((event: ToolCallGuardrailTriggeredEvent) => void) | undefined;
}

/** Event emitted when a session becomes tainted. */
export interface SessionTaintedEvent {
  reason: string;
  detector: string;
  confidence: number;
  step: number;
  /**
   * Where the content that caused the taint originated from. Defaults to
   * `'user-input'` for taints raised by the input guardrail hook; retrieval
   * surfaces (memory recall, ingested documents, skill resources) that feed
   * their own `GuardrailTriggeredEvent`s into a taint tracker should pass
   * their `event.provenance` through here.
   */
  provenance?: GuardrailProvenance | undefined;
}

/** Options for configuring session tainting behavior. */
export interface SessionTaintOptions {
  taintThreshold?: number | undefined;
  escalatedDetectors?: InputDetector[] | undefined;
  escalatedValidators?: OutputValidator[] | undefined;
  onTainted?: ((event: SessionTaintedEvent) => void) | undefined;
}

/** Combined options for the guardrails composition factory. */
export interface GuardrailsOptions {
  input?: InputGuardrailGroupOptions | undefined;
  output?: OutputGuardrailGroupOptions | undefined;
  /** Validators every tool call is judged by before it runs (COR-2104). */
  tools?: ToolCallGuardrailOptions | undefined;
  taint?: SessionTaintOptions | undefined;
  /**
   * `'validate'` (default) — a tripped detector/validator substitutes a
   * blocked/sanitized/redacted response and the run continues, per each
   * guardrail's own `action`.
   *
   * `'tripwire'` — OpenAI-tripwire model: input detectors gate the first
   * generate call and every tool result, and output validators gate
   * post-processing; a tripped wire
   * throws a `GuardrailTripwireError`, hard-halting the run with a clean
   * `finishReason: 'tripwire'` terminal result and a `run.tripwire` event
   * identifying the guardrail — distinct from `'validate'`'s retry/substitute
   * behavior. Overrides `input.action`/`output.action`/`tools.action` to
   * `'tripwire'` regardless of what they were set to. It sets a group's
   * action, not an entry's own: a detector, validator or tool-call validator
   * that carries its own `action` keeps it under either mode (COR-2104).
   */
  mode?: ('validate' | 'tripwire') | undefined;
}

/** Hooks returned by the guardrails composition factory. */
export interface GuardrailHooks {
  prepareStep: PrepareStepHook;
  validateResponse: ValidateResponseHook;
  /**
   * COR-2103 — runs the input detectors over each tool result before the model is shown it, with
   * provenance `'tool-result'`. Under `mode: 'tripwire'` a detection halts the run with phase
   * `'tool-result'`; otherwise `input.action` decides: `block` and `sanitize` replace the result
   * with a `GUARDRAIL_BLOCKED` error and always taint the session, and `warn` passes it through,
   * tainting at or above the taint threshold. A no-op without `input`. Register it on the
   * `validateToolResult` waterfall last, so no later handler overrules it.
   */
  validateToolResult: ValidateToolResultHook;
  /**
   * COR-2104 — judges each tool call with the `tools` validators before it runs. A call a validator
   * blocks is refused (`ToolExecutionHookContext.refuse`) and left out of the returned list; a
   * tripwire halts the run with phase `'tool-call'`. Returns the calls unchanged without `tools`.
   * Register it on `beforeToolExecution` last, so it judges the calls every other hook settled on.
   */
  beforeToolExecution: BeforeToolExecutionHook;
  /**
   * The session's taint tracker. Retrieval surfaces outside operative's run
   * loop — memory recall, ingested documents, skill resources — don't go
   * through `prepareStep`/`validateResponse`, but their `scanContent()`
   * `onTriggered` callbacks can call `taint.taint(event)` directly to fold
   * their detections into the same session-wide taint state.
   */
  taint: SessionTaintTracker;
}

/** State tracker for session tainting. */
export interface SessionTaintTracker {
  isTainted: () => boolean;
  taint: (event: SessionTaintedEvent) => void;
  getDetectors: () => InputDetector[];
  getValidators: () => OutputValidator[];
}
