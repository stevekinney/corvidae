import type { ConversationHistory, Message } from 'conversationalist';
import { appendMessages, createProjection, isMediaContent } from 'conversationalist';

import { createCatalogMediaCostEstimator } from '../../context/media-cost.ts';
import type { TokenBudget } from '../../context/token-budget.ts';
import type {
  ContextAssembler,
  MediaCostEstimator,
  UnadmittedMediaCost,
} from '../../context/types.ts';
import { MediaAdmissionError } from '../../errors.ts';
import type { BackendDescriptor } from '../model-catalog.ts';
import type { GenerateContext } from '../types.ts';

/**
 * Creates a stateful helper that runs `assembler` in stable-prefix mode on
 * every call and folds the result into an incremental `ConversationHistory`
 * through `createProjection` — the same conversation-level prefix-extension
 * mechanism AB-98 built for incremental streaming projections. Reusing one
 * projection instance across calls means the unchanged stable prefix is
 * never re-processed, only the new tail; the `cacheBoundary` mark that
 * landed on the prefix's last message the first time it was appended is
 * therefore preserved untouched for as long as it stays a prefix extension.
 *
 * Shared by every provider whose caching is driven by that mark. What each
 * provider does with it differs — Anthropic lowers it to a `cache_control`
 * breakpoint on the request it was already sending, Gemini splits the
 * conversation there and creates an out-of-band `CachedContent` resource —
 * but the assembly step that produces it is identical, so it is stated once.
 *
 * Media (COR-716). The projection keeps each assembled message as it is, id
 * included, because a resolved source is keyed by the message id it was
 * resolved for; re-minting ids would orphan every resolution. Media is costed
 * with the budget's own estimator or, when it has none, with the catalog
 * estimator over the provider's `descriptors` and the step's resolved sources,
 * the same estimator run admission uses. A message holding media is never left
 * out silently: if the assembly omits one, whether because a part could not be
 * costed or because the budget cannot hold it, the request fails with a
 * `MediaAdmissionError` naming the parts.
 *
 * `pinnedMessages` are host configuration, assembled here inside the provider,
 * never user input: they do not pass run-step admission (COR-716), and a media
 * part among them reaches the adapter on the host's own authority.
 */
export function createCacheAwareAssembly(
  assembler: ContextAssembler,
  budget: TokenBudget,
  pinnedMessages: ReadonlyArray<Message> | undefined,
  descriptors: readonly BackendDescriptor[],
): (context: GenerateContext) => ConversationHistory {
  const projection = createProjection<Message>({
    identify: (message) => message.id,
    // The assembled message itself, not a copy of its fields: `appendMessages`
    // takes an already-built message as is, so its id and `cacheBoundary` mark
    // survive into the request's conversation.
    reduce: ({ conversation, event }) => appendMessages(conversation, event),
  });

  return (context: GenerateContext): ConversationHistory => {
    const catalogEstimate = createCatalogMediaCostEstimator(descriptors, {
      resolvedSources: context.resolvedSources,
    });
    const mediaCostEstimator: MediaCostEstimator = (part, position) => {
      const outcome = budget.estimateMedia(part, position);
      return outcome.outcome === 'unbounded' && outcome.reason === 'no-estimator'
        ? catalogEstimate(part, position)
        : outcome;
    };
    const { messages, mediaCosts } = assembler({
      conversation: context.conversation,
      budget,
      stablePrefix: true,
      mediaCostEstimator,
      ...(pinnedMessages ? { pinnedMessages } : {}),
    });
    refuseOmittedMedia(context, messages, mediaCosts);
    projection.apply(messages);
    return projection.snapshot();
  };
}

/** Throws unless every visible message holding media made it into the assembly. */
function refuseOmittedMedia(
  context: GenerateContext,
  assembled: readonly Message[],
  mediaCosts: readonly (UnadmittedMediaCost | { readonly outcome: 'estimated' })[],
): void {
  const kept = new Set(assembled.map((message) => message.id));
  const refused: UnadmittedMediaCost[] = mediaCosts.filter(
    (cost): cost is UnadmittedMediaCost => cost.outcome !== 'estimated',
  );
  const reported = new Set(refused.map((cost) => `${cost.messageId}:${cost.partIndex}`));
  for (const message of context.conversation.getMessages()) {
    if (message.hidden || kept.has(message.id) || typeof message.content === 'string') continue;
    message.content.forEach((part, partIndex) => {
      if (!isMediaContent(part) || reported.has(`${message.id}:${partIndex}`)) return;
      refused.push({
        messageId: message.id,
        partIndex,
        modality: part.type,
        outcome: 'unsupported',
        reason: 'media-over-budget',
      });
    });
  }
  if (refused.length > 0) {
    // A part that was costed and admitted beside a refusal means the message is not one the model
    // takes none of. (An estimated part of a dropped message is also reported refused, as
    // `media-over-budget`, which keeps the code the same.)
    throw new MediaAdmissionError(refused, {
      admitted: mediaCosts.filter((cost) => cost.outcome === 'estimated'),
    });
  }
}
