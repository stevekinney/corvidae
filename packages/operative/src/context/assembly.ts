/**
 * Context assembly for building the message window sent to the model.
 *
 * The assembler applies budget ratios to decide how many tokens each slice
 * (system, history, retrieved) may consume, then trims messages to fit.
 */

import type { MediaContent, Message, MultiModalContent, TextContent } from 'conversationalist';
import { isMediaContent } from 'conversationalist';

import { getPendingToolCallIds } from './pending-tool-calls';
import type {
  AssemblyOptions,
  AssemblyResult,
  BudgetReport,
  ContextAssembler,
  MediaCostEstimator,
  MediaCostOutcome,
} from './types';

/** Default token estimator: roughly 4 characters per token. */
const defaultEstimator = (text: string): number => Math.ceil(text.length / 4);

/** What it costs to hold one message in the window. */
interface MessageCost {
  /** Total tokens: text, structural blocks, tool payloads, and admitted media. */
  readonly tokens: number;
  /** The part of `tokens` that media parts cost. */
  readonly mediaTokens: number;
  /** One outcome per media part. */
  readonly mediaOutcomes: readonly MediaCostOutcome[];
  /** False when any media part is not `estimated`: the message must not be admitted. */
  readonly admissible: boolean;
}

/** The text a structural (non-text, non-media) block contributes to the estimate. */
function structuralPartText(part: Exclude<MultiModalContent, TextContent | MediaContent>): string {
  switch (part.type) {
    case 'thinking':
      return part.thinking + part.signature;
    case 'redacted_thinking':
      return part.data;
    case 'server_tool_use':
      return part.name + JSON.stringify(part.input);
    case 'container_upload':
      return part.file_id;
    default:
      return JSON.stringify(part.content);
  }
}

/**
 * Estimates what a single message costs using the provided estimators. Media
 * parts are costed by `mediaCostEstimator`; a part whose outcome is not
 * `estimated` contributes no tokens and makes the message inadmissible, because
 * admitting it would price it at zero.
 */
function estimateMessage(
  message: Message,
  estimator: (text: string) => number,
  mediaCostEstimator: MediaCostEstimator,
): MessageCost {
  let tokens = 0;
  let mediaTokens = 0;
  const mediaOutcomes: MediaCostOutcome[] = [];

  if (typeof message.content === 'string') {
    tokens += estimator(message.content);
  } else {
    message.content.forEach((part, partIndex) => {
      if (part.type === 'text') {
        tokens += estimator(part.text);
      } else if (isMediaContent(part)) {
        const outcome = mediaCostEstimator(part, { messageId: message.id, partIndex });
        mediaOutcomes.push(outcome);
        // The portable text a media part carries is read by the model too.
        tokens += estimator(portableMediaText(part));
        if (outcome.outcome === 'estimated') {
          tokens += outcome.tokens;
          mediaTokens += outcome.tokens;
        }
      } else {
        tokens += estimator(structuralPartText(part));
      }
    });
  }

  if (message.toolCall) {
    tokens += estimator(
      JSON.stringify({ name: message.toolCall.name, arguments: message.toolCall.arguments }),
    );
  }
  if (message.toolResult) {
    const resultContent =
      typeof message.toolResult.content === 'string'
        ? message.toolResult.content
        : JSON.stringify(message.toolResult.content);
    tokens += estimator(resultContent);
    // A result's parts are what the model reads: text as text, media through the media
    // estimator under the same `messageId:partIndex` key its resolution uses.
    message.toolResult.parts?.forEach((part, partIndex) => {
      if (part.type === 'text') {
        tokens += estimator(part.text);
        return;
      }
      const outcome = mediaCostEstimator(part, { messageId: message.id, partIndex });
      mediaOutcomes.push(outcome);
      tokens += estimator(portableMediaText(part));
      if (outcome.outcome === 'estimated') {
        tokens += outcome.tokens;
        mediaTokens += outcome.tokens;
      }
    });
  }

  return {
    tokens,
    mediaTokens,
    mediaOutcomes,
    admissible: mediaOutcomes.every((outcome) => outcome.outcome === 'estimated'),
  };
}

/** The text fields a media part carries alongside its source. */
function portableMediaText(part: MediaContent): string {
  return [part.name, part.alt, part.caption, part.transcript, part.extractedText]
    .filter((value): value is string => value !== undefined)
    .join('\n');
}

/**
 * Creates a context assembler that partitions the conversation into budget
 * slices (system, history, retrieved) and returns the assembled messages
 * with an accurate budget report.
 *
 * Guarantees:
 * - System messages are always included (up to the system budget).
 * - The most recent N non-system messages are always included.
 * - Messages with pending tool results are always included.
 * - Hidden messages are excluded.
 * - A budget report is returned with per-slice token counts.
 */
export function createContextAssembler(): ContextAssembler {
  return (options: AssemblyOptions): AssemblyResult => {
    const {
      conversation,
      budget,
      recentMessageCount = 4,
      systemBudgetRatio = 0.25,
      historyBudgetRatio = 0.6,
      retrievedBudgetRatio = 0.15,
      retrievedMessages = [],
      tokenEstimator = budget.estimate?.bind(budget) ?? defaultEstimator,
      stablePrefix = false,
      pinnedMessages = [],
    } = options;
    const mediaCostEstimator: MediaCostEstimator =
      options.mediaCostEstimator ?? ((part, position) => budget.estimateMedia(part, position));

    // Each message is costed once. Its media outcomes are reported whether or
    // not the message ends up in the window.
    const costs = new Map<Message, MessageCost>();
    const costOf = (message: Message): MessageCost => {
      let cost = costs.get(message);
      if (cost === undefined) {
        cost = estimateMessage(message, tokenEstimator, mediaCostEstimator);
        costs.set(message, cost);
      }
      return cost;
    };
    const reportMediaCosts = (): MediaCostOutcome[] => {
      const seen = new Set<string>();
      const outcomes: MediaCostOutcome[] = [];
      for (const cost of costs.values()) {
        for (const outcome of cost.mediaOutcomes) {
          const key = `${outcome.messageId}:${outcome.partIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          outcomes.push(outcome);
        }
      }
      return outcomes;
    };
    let mediaTokens = 0;
    const admit = (message: Message): number => {
      const cost = costOf(message);
      mediaTokens += cost.mediaTokens;
      return cost.tokens;
    };

    const allMessages = conversation.getMessages();

    // Filter out hidden messages
    const visibleMessages = allMessages.filter((m) => !m.hidden);

    if (
      visibleMessages.length === 0 &&
      retrievedMessages.length === 0 &&
      pinnedMessages.length === 0
    ) {
      return {
        messages: [],
        budgetReport: {
          systemTokens: 0,
          historyTokens: 0,
          retrievedTokens: 0,
          mediaTokens: 0,
          totalTokens: 0,
          remainingTokens: budget.maxTokens,
        },
        mediaCosts: [],
      };
    }

    // Calculate per-slice budgets. Clamp the total ratio to 1.0 to prevent
    // over-allocation when user-supplied ratios exceed the available budget.
    const totalRatio = systemBudgetRatio + historyBudgetRatio + retrievedBudgetRatio;
    const scale = totalRatio > 1 ? 1 / totalRatio : 1;
    const allocatable = budget.allocate();
    const systemBudget = Math.floor(allocatable * systemBudgetRatio * scale);
    const historyBudget = Math.floor(allocatable * historyBudgetRatio * scale);
    const retrievedBudget = Math.floor(allocatable * retrievedBudgetRatio * scale);

    // Partition messages
    const systemMessages = visibleMessages.filter((m) => m.role === 'system');
    const nonSystem = visibleMessages.filter((m) => m.role !== 'system');

    // Identify messages that MUST be included
    const pendingCallIds = getPendingToolCallIds(visibleMessages);
    const mustIncludeIds = new Set<string>();

    // Pending tool calls are mandatory
    for (const message of visibleMessages) {
      if (
        message.role === 'tool-call' &&
        message.toolCall &&
        pendingCallIds.has(message.toolCall.id)
      ) {
        mustIncludeIds.add(message.id);
      }
    }

    // Recent messages are mandatory
    const recentMessages = nonSystem.slice(-recentMessageCount);
    for (const m of recentMessages) {
      mustIncludeIds.add(m.id);
    }

    // Assemble system messages. In stable-prefix mode the system prompt is
    // never budget-truncated — a stable prefix that could silently drop its
    // own instructions on a token squeeze is not actually stable, it's
    // unreliable. Default mode keeps the original budget-capped behavior.
    const assembledSystem: Message[] = [];
    let systemTokens = 0;
    for (const msg of systemMessages) {
      const { tokens, admissible } = costOf(msg);
      if (!admissible) continue;
      if (stablePrefix || systemTokens + tokens <= systemBudget || assembledSystem.length === 0) {
        assembledSystem.push(msg);
        systemTokens += admit(msg);
      }
    }

    // In stable-prefix mode, pinned messages are always included in full,
    // verbatim and in order, immediately after system messages. Their tokens
    // are folded into the system budget slice of the report.
    const assembledPinned: Message[] = [];
    if (stablePrefix) {
      for (const msg of pinnedMessages) {
        if (msg.hidden) continue;
        if (!costOf(msg).admissible) continue;
        assembledPinned.push(msg);
        systemTokens += admit(msg);
      }
    }

    // The stable prefix is system messages + pinned messages, in that order.
    // Everything else (retrieved, history) is assembled and appended after
    // it, unaffected by stable-prefix mode. Mark the LAST message of the
    // stable prefix with `cacheBoundary: true` — a shallow copy, so the
    // underlying conversation is never mutated — so a provider adapter can
    // lower it to a native prompt-cache checkpoint (e.g. Anthropic's
    // `cache_control`). Only meaningful when the prefix is non-empty.
    const stableFront: Message[] = [...assembledSystem, ...assembledPinned];
    if (stablePrefix && stableFront.length > 0) {
      const lastIndex = stableFront.length - 1;
      const boundaryMessage = stableFront[lastIndex];
      if (boundaryMessage) {
        stableFront[lastIndex] = { ...boundaryMessage, cacheBoundary: true };
      }
    }

    // Assemble history messages within budget
    // Start with mandatory messages, then fill with older history
    const assembledHistory: Message[] = [];
    // A pinned message keeps its id (COR-716: a resolved source is keyed by it),
    // so one that also sits in the history is already included and must not be
    // assembled a second time, which the conversation integrity check refuses.
    const includedIds = new Set<string>(
      [...assembledSystem, ...assembledPinned].map((message) => message.id),
    );
    let historyTokens = 0;

    // First, include all mandatory non-system messages
    for (const msg of nonSystem) {
      if (mustIncludeIds.has(msg.id)) {
        if (includedIds.has(msg.id)) continue;
        // A mandatory message with media that cannot be costed is still not
        // admitted at zero; its outcome is in `mediaCosts` and the run refuses it.
        if (!costOf(msg).admissible) continue;
        assembledHistory.push(msg);
        includedIds.add(msg.id);
        historyTokens += admit(msg);
      }
    }

    // Then fill with remaining history from oldest to newest (up to budget)
    for (const msg of nonSystem) {
      if (includedIds.has(msg.id)) continue;
      const { tokens, admissible } = costOf(msg);
      if (admissible && historyTokens + tokens <= historyBudget) {
        assembledHistory.push(msg);
        includedIds.add(msg.id);
        historyTokens += admit(msg);
      }
    }

    // Sort history by position to maintain conversation order
    assembledHistory.sort((a, b) => a.position - b.position);

    // Assemble retrieved messages within budget
    const assembledRetrieved: Message[] = [];
    let retrievedTokens = 0;
    for (const msg of retrievedMessages) {
      if (msg.hidden) continue;
      const { tokens, admissible } = costOf(msg);
      if (admissible && retrievedTokens + tokens <= retrievedBudget) {
        assembledRetrieved.push(msg);
        retrievedTokens += admit(msg);
      }
    }

    // Combine all assembled messages in order: stable prefix (system, then
    // pinned in stable-prefix mode) first, then retrieved (injected before
    // history), then history.
    const combined: Message[] = [...stableFront, ...assembledRetrieved, ...assembledHistory];

    const totalTokens = systemTokens + historyTokens + retrievedTokens;

    const budgetReport: BudgetReport = {
      systemTokens,
      historyTokens,
      retrievedTokens,
      mediaTokens,
      totalTokens,
      remainingTokens: budget.maxTokens - totalTokens,
    };

    return { messages: combined, budgetReport, mediaCosts: reportMediaCosts() };
  };
}
