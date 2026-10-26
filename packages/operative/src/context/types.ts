/**
 * Types for the context engine.
 *
 * Defines the public interfaces for token budgeting, context assembly,
 * compaction strategies, and the top-level context engine options.
 */

import type { Conversation, MediaContent, Message, Modality } from 'conversationalist';

import type { TokenBudget } from './token-budget';

/** Options controlling how the context window is assembled before a generate call. */
export interface AssemblyOptions {
  conversation: Conversation;
  budget: TokenBudget;
  /** Number of most-recent messages to always include. Default: `4`. */
  recentMessageCount?: number | undefined;
  /** Fraction of allocatable budget reserved for system messages. Default: `0.25`. */
  systemBudgetRatio?: number | undefined;
  /** Fraction of allocatable budget reserved for conversation history. Default: `0.60`. */
  historyBudgetRatio?: number | undefined;
  /** Fraction of allocatable budget reserved for retrieved messages. Default: `0.15`. */
  retrievedBudgetRatio?: number | undefined;
  /** Additional retrieved messages (e.g. from memory) to include when budget allows. */
  retrievedMessages?: ReadonlyArray<Message> | undefined;
  /** Override the per-text token estimator. */
  tokenEstimator?: ((text: string) => number) | undefined;
  /**
   * Enables prompt-cache-aware assembly. When `true`, system messages and
   * `pinnedMessages` are assembled into a stable prefix that stays
   * byte-identical across calls as the conversation grows — no budget
   * truncation, no re-ranking — and the last message of that prefix is
   * returned with `cacheBoundary: true` so a provider adapter (e.g.
   * `toAnthropicMessages`) can lower it to a `cache_control` breakpoint.
   * History and `retrievedMessages` are unaffected: they are assembled
   * exactly as in the default mode and appended AFTER the stable prefix, so
   * their per-step re-ranking never touches the cached region.
   * Default: `false`.
   */
  stablePrefix?: boolean | undefined;
  /**
   * Messages always included, verbatim and in order, immediately after the
   * system messages and before conversation history. Unlike
   * `retrievedMessages`, these are never re-ranked or dropped by budget
   * pressure — they are part of the stable prefix (e.g. pinned reference
   * material). Only consulted when `stablePrefix` is `true`.
   */
  pinnedMessages?: ReadonlyArray<Message> | undefined;
  /**
   * Costs each media part. Defaults to the budget's own `estimateMedia`, which
   * reports every part as `unbounded` (`no-estimator`) unless the budget was
   * created with an estimator. A message holding a part whose outcome is not
   * `estimated` is never admitted at zero cost: it is left out of the assembled
   * messages and its outcome is returned in {@link AssemblyResult.mediaCosts}.
   */
  mediaCostEstimator?: MediaCostEstimator | undefined;
}

/** Where a media part sits: the message that holds it and its index in that message's content. */
export interface MediaPartPosition {
  readonly messageId: string;
  readonly partIndex: number;
}

/**
 * The typed outcome of costing one media part. Only `estimated` admits the part
 * to a context window; `unsupported` and `unbounded` are policy outcomes, never
 * a zero.
 */
export type MediaCostOutcome =
  | (MediaPartPosition & {
      readonly outcome: 'estimated';
      readonly modality: Modality;
      readonly tokens: number;
      readonly basis: 'provider-count' | 'catalog-estimate';
    })
  | (MediaPartPosition & {
      readonly outcome: 'unsupported';
      readonly modality: Modality;
      readonly reason:
        | 'modality-not-accepted'
        | 'source-form-not-accepted'
        | 'mime-family-not-accepted'
        | 'media-count-exceeded'
        | 'asset-flagged'
        | 'asset-unverified'
        | 'media-over-budget'
        | 'no-route-admits-media'
        | 'no-backend-admits-media'
        | 'mime-type-mismatch';
      /**
       * The reason a content-source resolver gave when it could not project the part (for
       * example `mcp-resource-not-found` or `asset-not-found`), on a `source-form-not-accepted`
       * refusal that came from a resolver rather than from the backend.
       */
      readonly detail?: string | undefined;
    })
  | (MediaPartPosition & {
      readonly outcome: 'unbounded';
      readonly modality: Modality;
      readonly reason: 'no-estimator' | 'size-unknown' | 'media-limit-exceeded';
    });

/** Costs one media part against the backend the run will call. */
export type MediaCostEstimator = (
  part: MediaContent,
  position: MediaPartPosition,
) => MediaCostOutcome;

/** A media cost outcome that does not admit its part. */
export type UnadmittedMediaCost = Exclude<MediaCostOutcome, { outcome: 'estimated' }>;

/** Breakdown of token usage across context slices. */
export interface BudgetReport {
  systemTokens: number;
  historyTokens: number;
  retrievedTokens: number;
  /** Tokens the included messages' media parts cost; already counted in the slice totals. */
  mediaTokens: number;
  totalTokens: number;
  remainingTokens: number;
}

/** The result of assembling a context window. */
export interface AssemblyResult {
  messages: ReadonlyArray<Message>;
  budgetReport: BudgetReport;
  /** One outcome per media part in every message the assembler considered. */
  mediaCosts: ReadonlyArray<MediaCostOutcome>;
}

/** A function that assembles the context window from a conversation and budget. */
export type ContextAssembler = (options: AssemblyOptions) => AssemblyResult;

/** Options controlling how compaction strategies operate. */
export interface CompactionOptions {
  /** Number of recent messages to always retain. Default: `4`. */
  retainRecentMessages?: number | undefined;
  /** Summarizer function for strategies that need it. */
  summarize?: ((messages: ReadonlyArray<Message>) => Promise<string>) | undefined;
  /** Maximum age (in turns) for tool results before they are eligible for pruning. */
  maxToolResultAge?: number | undefined;
  /**
   * Preserve tool-result messages with `toolResult.outcome === 'error'` or
   * `metadata.error === true`, regardless of age. Default: `true`. Mirrors
   * the `errors` flag in conversationalist's `CompactionPreservePolicy` (see
   * `Conversation.compact()`), so both compaction paths agree on the same
   * preserve-by-default posture — error results are diagnostic signal that
   * age-based pruning would otherwise discard. Set to `false` to opt back
   * into pruning errors purely by age.
   */
  preserveErrorToolResults?: boolean | undefined;
}

/** A function that compacts a conversation to free tokens. */
export type CompactionStrategy = (
  conversation: Conversation,
  budget: TokenBudget,
  options: CompactionOptions,
) => Promise<void>;

/** Top-level options for creating a context engine. */
export interface ContextEngineOptions {
  maxTokens: number;
  /** Minimum tokens reserved for the model response. Default: `1500`. */
  minimumResponseTokens?: number | undefined;
  /** Warning when remaining tokens drop to this level. Default: 20% of `maxTokens`. */
  warningThreshold?: number | undefined;
  /** Compaction triggered when used tokens reach this level. Default: 80% of `maxTokens`. */
  compactionThreshold?: number | undefined;
  /** Override the per-text token estimator. */
  tokenEstimator?: ((text: string) => number) | undefined;
  /** Override the context assembler. */
  assembler?: ContextAssembler | undefined;
}
