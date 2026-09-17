import { createToolbox } from '@repo/armorer';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
  getMessages,
  type ConversationHistory,
  type Message,
} from '@repo/chat';
import { appendSystemMessage } from '@repo/conversationalist';
import { createAgent, createContextCompactor } from '@repo/operative';
import {
  allSummariesReachProjection,
  chunkRangesOf,
  chunksAreChronological,
  countRawSummarizedInProjection,
  distinctStrings,
  errorNameOf,
  messageShape,
  partitionIsExact,
  snapshotMessages,
  summariesAreInOrder,
  summarizerInputsAreIntact,
  summaryOrderOf,
} from './compaction-observation-metrics';

// Context compaction, and what it does NOT touch.
//
// Compaction rewrites the conversation the MODEL sees: older messages are
// summarized into a single system message, a few recent ones are kept, and
// anything the preserve policy protects is carried through.
//
// "Carried through" is precise here rather than loose: role, content, and
// metadata survive unchanged — including the `pinned` flag, without which
// the next compaction would summarize the message away — but the IDS DO
// NOT. Compaction rebuilds what it keeps, so the projection shares none of
// the seeded conversation's message ids. Anything keyed to a message id
// across a compaction boundary is keyed to something that no longer
// exists. This page seeds a transcript long enough to trigger that, pins
// one fact inside the part that gets summarized away, and shows the
// projection the first generate call actually received.
//
// The second half is the part worth internalizing: the page's own
// transcript is untouched. `agent.run({ conversation })` SNAPSHOTS the
// `ConversationHistory` it is handed — it clones it before wrapping it in
// the run's internal `Conversation` — so compaction, and every other
// mutation the loop makes, lands on the run's copy. A host that keeps
// rendering its own history across turns never sees its transcript
// silently rewritten underneath it.
//
// Everything is local: `summarize` is a function that counts messages.
// The point of compaction is the reshaping, not the summary text, and a
// deterministic stand-in makes the reshaping assertable.

/**
 * Microtask yields granted to the first summarizer callback, decreasing by
 * one per subsequent call. Large enough that a parallel dispatch would
 * visibly invert completion order, small enough to stay free.
 */
const MAXIMUM_SUMMARY_SKEW = 8;

const PINNED_FACT = 'The deployment key rotates every 90 days.';
const FIRST_FILLER_QUESTION = 'What did we decide about the staging bucket?';
const FILLER_BODY =
  'Context that exists only to push this transcript past the token budget. '.repeat(4);

function seedTranscript(): ConversationHistory {
  let conversation = createConversationHistory({ id: 'exercise-compaction' });
  conversation = appendSystemMessage(conversation, 'You are a release assistant.');
  // `pinned: true` is what the preserve policy reads. Without it this
  // message sits in the middle of the summarized range and would be
  // paraphrased away with the rest.
  conversation = appendUserMessage(conversation, PINNED_FACT, { pinned: true });
  conversation = appendUserMessage(conversation, FIRST_FILLER_QUESTION);
  conversation = appendAssistantMessage(conversation, `We kept it. ${FILLER_BODY}`);
  for (let index = 0; index < 5; index += 1) {
    // TWO out-of-window negative controls, because
    // `metadata.pinned === true` has two distinct ways to regress and
    // one control cannot separate them: index 1 carries unrelated
    // metadata, catching a predicate that preserves anything with
    // metadata defined at all; index 2 carries `pinned: false`,
    // catching one that tests truthiness loosely or asks
    // `'pinned' in metadata`. Both must be summarized away.
    //
    // One out-of-window message carries metadata that is NOT `pinned`.
    // Without it the pinned message is the only old message with any
    // metadata at all, so a compactor that regressed to preserving
    // everything with defined metadata — rather than checking
    // `metadata.pinned === true` — would produce this same projection
    // and pass every assertion. This one has to be summarized away.
    conversation = appendUserMessage(
      conversation,
      `Follow-up ${index}. ${FILLER_BODY}`,
      index === 1 ? { topic: 'staging-bucket' } : index === 2 ? { pinned: false } : undefined,
    );
    conversation = appendAssistantMessage(conversation, `Answer ${index}. ${FILLER_BODY}`);
  }
  return conversation;
}

const seeded = seedTranscript();

const contains = (messages: readonly Message[], needle: string): boolean =>
  messages.some((message) => JSON.stringify(message.content).includes(needle));

type Observation = {
  seededLengthBefore: number;
  seededLengthAfter: number;
  seededIdentical: boolean;
  seededControlIdentical: boolean;
  projectionDiffers: boolean;
  seededHasPin: boolean;
  seededHasFirstFiller: boolean;
  projectionLength: number;
  projectionHasPin: boolean;
  projectionHasFirstFiller: boolean;
  projectionHasSummary: boolean;
  projectionRoles: string;
  summarizedMessages: number;
  foreignMessages: number;
  carriedVerbatim: number;
  projectionOrder: string;
  inBothBuckets: number;
  inNeitherBucket: number;
  partitionExact: boolean;
  pinnedMetadataSurvives: boolean;
  metadataControlSummarized: boolean;
  falsePinnedControlSummarized: boolean;
  rawSummarizedInProjection: number;
  carriedIdOverlap: number;
  allSummariesReachProjection: boolean;
  summaryChunks: string;
  duplicateSummarizerInputs: number;
  summaryOrder: string;
  summariesInOrder: boolean;
  chunkRanges: string;
  chunksChronological: boolean;
  emptyChunks: number;
  everyMarkerOnce: boolean;
  markerOccurrences: string;
  generateCalls: number;
  finishReason: string;
  runError: string;
  steps: number;
  summarizerInputsIntact: boolean;
};

export async function observe(): Promise<Observation> {
  const before = getMessages(seeded);
  const beforeSnapshot = snapshotMessages(before);
  // Positive control, taken before anything runs: two reads of an
  // untouched history must already agree. Without it, "identical after
  // the run" could just mean the serialization is insensitive to
  // everything.
  const controlSnapshot = snapshotMessages(getMessages(seeded));

  // What actually reached the summarizer, counted by message id rather
  // than by call. Compaction chunks its input, and the chunk sizes are
  // conversationalist's business — asserting them would pin an internal.
  // Distinct ids are the chunking-agnostic measure: they stay the same
  // however the work is divided up.
  //
  // Plain arrays rather than a `Set`: `svelte/prefer-svelte-reactivity`
  // flags a mutable `Set` in a component, and the reactive `SvelteSet`
  // it points to would be the wrong instrument — nothing observes these,
  // they are local accumulators inside one async function. Fourteen
  // messages make the linear scans free.
  const seededIds = before.map((message) => message.id);
  const seenIds: string[] = [];
  // One distinct marker per call. Compaction summarizes in chunks, and
  // with every chunk returning the same text a discarded result would be
  // invisible — the projection would still contain a summary-shaped
  // message and every other assertion would hold. Distinct markers make
  // "every chunk's summary survived" checkable without pinning HOW MANY
  // chunks there were, which is conversationalist's business.
  const markers: string[] = [];
  // Reserved SYNCHRONOUSLY, before any await. Deriving the invocation
  // index from `markers.length` after the delay defeated the skew
  // entirely: under the parallel dispatch this is meant to detect, every
  // callback reads the same length before any of them pushes, so all
  // wait the same number of ticks and settle FIFO anyway.
  let summarizeInvocations = 0;
  // Each chunk's seed positions, so the ORDER THE CALLBACKS RECEIVED can
  // be checked as well as the order their results landed in. Marker
  // positions alone only prove the returned strings were concatenated in
  // callback order — if compaction fed the chunks newest-first, they
  // would still ascend while the model read the history backwards.
  const chunkSeedPositions: number[][] = [];
  // `{ id, shape }` pairs rather than a bag of shapes. A membership test
  // answers "was this shape somewhere in the seed", which a compactor
  // that kept every id in order while giving one message ANOTHER seeded
  // message's role, content, or metadata would satisfy. The pair lets
  // each shape be checked against the seeded message of that same id.
  const summarizerInputs: { id: string; shape: string }[] = [];

  let projection: readonly Message[] = [];
  // Captured on the FIRST call and not overwritten. The panel's claim is
  // about the projection the first generation received; assigning on
  // every call would quietly show a later one, and a second provider
  // call would leave no trace at all — which is why the count is
  // rendered and asserted alongside it.
  let generateCalls = 0;
  const agent = createAgent({
    generate: async (context) => {
      generateCalls += 1;
      // The model-visible projection, read at the only moment it
      // exists as such: inside the generate call, after the loop has
      // applied compaction for this step.
      if (generateCalls === 1) projection = context.conversation.getMessages();
      return { content: 'Understood.', toolCalls: [] };
    },
    toolbox: createToolbox([]),
    contextManagement: {
      maxTokens: 400,
      onCompact: createContextCompactor({
        summarize: async (messages) => {
          // Deliberate, deterministic skew in COMPLETION order.
          //
          // Every callback here would otherwise resolve
          // immediately, so invocation order and completion order
          // always coincide and `summariesInOrder` cannot tell
          // them apart. A compactor that dispatched chronological
          // chunks in parallel and concatenated results as their
          // promises settled would reorder the summary under
          // real, variable-latency summarizers while this fixture
          // stayed green.
          //
          // Earlier chunks yield for MORE microtasks than later
          // ones, so under parallel dispatch the later chunks
          // settle first. Microtasks rather than timers: no
          // wall-clock cost, and fully deterministic. Sequential
          // dispatch is unaffected beyond a few extra ticks.
          const invocation = summarizeInvocations;
          summarizeInvocations += 1;
          for (let tick = MAXIMUM_SUMMARY_SKEW - invocation; tick > 0; tick -= 1) {
            await Promise.resolve();
          }
          for (const message of messages) seenIds.push(message.id);
          // Bound to the RESERVED index rather than appended: under
          // parallel dispatch an append would record these in
          // completion order, which is precisely the order this
          // fixture is trying to scramble.
          chunkSeedPositions[invocation] = messages.map((message) => seededIds.indexOf(message.id));
          // The full shape, not just the id. Recording only ids would
          // let a compaction that preserved every id and its order
          // while altering a role, content, or metadata hand a real
          // summarizer altered context with every assertion green.
          for (const message of messages) {
            summarizerInputs.push({ id: message.id, shape: messageShape(message) });
          }
          const marker = `[summary ${invocation + 1} of ${messages.length} messages]`;
          markers[invocation] = marker;
          return marker;
        },
        retainRecentMessages: 2,
      }),
    },
  });
  // Kept rather than discarded. A loop that failed AFTER `generate` saw the
  // right projection — while appending the response, or finalizing the
  // compacted conversation — settles a terminal result carrying that
  // failure, and every projection, summarizer, and caller-history
  // assertion here would still pass over the top of it.
  const result = await agent.run({ conversation: seeded }).result();

  // Compared by CONTENT, never by object identity: `getMessages` builds
  // a fresh array on every call, so `after === before` is false for a
  // transcript nothing touched. The count and the message text are what
  // actually answer "was this rewritten?".
  const after = getMessages(seeded);
  // Counted rather than assumed to be one: the accounting below divides
  // the projection into "injected by compaction" and "carried through
  // from the seed", and hard-coding the first half would make the
  // invariant agree with itself.
  const injectedSummaries = projection.filter((message) =>
    JSON.stringify(message.content).includes('[summary '),
  ).length;
  const summarizedIds = distinctStrings(seenIds.filter((id) => seededIds.includes(id)));
  const foreignIds = distinctStrings(seenIds.filter((id) => !seededIds.includes(id)));

  // The partition proper, sorted into buckets per message rather than
  // inferred from two totals. Adding cardinalities would call it a
  // partition without ever checking one: a compaction that both
  // summarized AND retained one message while dropping another still
  // sums to the seeded length.
  const projectionShapes = projection.map(messageShape);
  const beforeShapes = before.map(messageShape);
  const buckets = before.map((message) => ({
    carried: projectionShapes.includes(messageShape(message)),
    summarized: summarizedIds.includes(message.id),
  }));
  const carriedVerbatim = buckets.filter((bucket) => bucket.carried).length;
  const inBothBuckets = buckets.filter((bucket) => bucket.carried && bucket.summarized).length;
  const inNeitherBucket = buckets.filter((bucket) => !bucket.carried && !bucket.summarized).length;

  // Membership is not enough: swapping the pinned message with a retained
  // recent one leaves every count, shape, and role check identical while
  // handing the model recent context ahead of the older pinned fact.
  // This maps the projection back onto the seed positionally, so the
  // summary's placement and the carried messages' order are both pinned
  // in one readable string.
  const projectionOrder = projection
    .map((message) => {
      const shape = messageShape(message);
      const seedPosition = before.findIndex(
        (seededMessage) => messageShape(seededMessage) === shape,
      );
      return seedPosition === -1 ? 'summary' : String(seedPosition);
    })
    .join(', ');

  // Presence is not order. If the chunk summaries were concatenated in
  // reverse, every marker would still be found and `projectionOrder`
  // would still call the containing message `summary` — while the model
  // read the summarized history backwards. Marker positions inside the
  // injected text answer that, and are rendered as the call order they
  // resolve to.
  const summaryText = projection
    .filter((message) => JSON.stringify(message.content).includes('[summary '))
    .map((message) => JSON.stringify(message.content))
    .join('\n');
  const markerPositions = markers.map((marker) => summaryText.indexOf(marker));
  // Occurrences, not membership. A callback result concatenated twice
  // leaves membership true, the distinct-marker count unchanged, and
  // `indexOf` pointing at the first copy — while the model reads the same
  // summarized context twice. The input-side duplicate counter says
  // nothing about this; it is the same failure on the other side.
  const markerCounts = markers.map((marker) => summaryText.split(marker).length - 1);
  const everyMarkerOnce = markerCounts.length > 0 && markerCounts.every((count) => count === 1);
  const summaryOrder = summaryOrderOf(markers, markerPositions);
  const summariesInOrder = summariesAreInOrder(markerPositions);
  const chunkRanges = chunkRangesOf(chunkSeedPositions);
  // Ascending within each chunk, and each chunk strictly after the last.
  //
  // `positions.length > 0` is load-bearing, not defensive: without it an
  // EMPTY chunk passes trivially, because `every` on an empty array is
  // true and `Math.min()` of nothing is `Infinity`, which beats any
  // previous chunk's maximum. An empty chunk means a wasted summarizer
  // call and a meaningless summary in the model's context, so it is also
  // counted on its own line.
  const chunksChronological = chunksAreChronological(chunkSeedPositions);
  const emptyChunks = chunkSeedPositions.filter((positions) => positions.length === 0).length;

  const metadataControl = before.find(
    (message) => message.metadata?.['topic'] === 'staging-bucket',
  );
  const falsePinnedControl = before.find((message) => message.metadata?.['pinned'] === false);
  const projectionText = projection.map((message) => JSON.stringify(message)).join('\n');

  const pinnedInProjection = projection.find((message) =>
    JSON.stringify(message.content).includes(PINNED_FACT),
  );
  return {
    seededLengthBefore: before.length,
    seededLengthAfter: after.length,
    seededIdentical: snapshotMessages(after) === beforeSnapshot,
    seededControlIdentical: controlSnapshot === beforeSnapshot,
    // Negative control: the projection IS a rewrite of the same
    // transcript, so the comparison above must call it different. A
    // comparison that returned "identical" for everything would pass
    // the line above and fail this one.
    projectionDiffers: snapshotMessages(projection) !== beforeSnapshot,
    seededHasPin: contains(after, PINNED_FACT),
    seededHasFirstFiller: contains(after, FIRST_FILLER_QUESTION),
    projectionLength: projection.length,
    projectionHasPin: contains(projection, PINNED_FACT),
    projectionHasFirstFiller: contains(projection, FIRST_FILLER_QUESTION),
    projectionHasSummary: injectedSummaries > 0,
    projectionRoles: projection.map((message) => message.role).join(', '),
    summarizedMessages: summarizedIds.length,
    // Anything the summarizer saw that this page did not seed — a
    // previous summary folded back in, say.
    foreignMessages: foreignIds.length,
    carriedVerbatim,
    projectionOrder,
    inBothBuckets,
    inNeitherBucket,
    // Every seeded message is in exactly one bucket, and the two
    // buckets plus the injected summary account for the whole
    // projection. That is the claim; the counts above are how a
    // failure gets read.
    partitionExact: partitionIsExact({
      beforeLength: before.length,
      carriedVerbatim,
      inBothBuckets,
      inNeitherBucket,
      injectedSummaries,
      projectionLength: projection.length,
      summarizedCount: summarizedIds.length,
    }),
    // The reason `metadata` is in the shape above, stated on its own
    // so a failure names the cause rather than a shape mismatch.
    pinnedMetadataSurvives: pinnedInProjection?.metadata?.['pinned'] === true,
    // The negative half of the same claim: metadata alone does not buy
    // preservation, only `pinned` does.
    metadataControlSummarized:
      metadataControl !== undefined &&
      summarizedIds.includes(metadataControl.id) &&
      !projectionShapes.includes(messageShape(metadataControl)),
    // …and `pinned: false` is not the same as `pinned` being present.
    // A predicate reading `'pinned' in metadata`, or testing it
    // loosely, preserves a message explicitly marked NOT pinned.
    falsePinnedControlSummarized:
      falsePinnedControl !== undefined &&
      summarizedIds.includes(falsePinnedControl.id) &&
      !projectionShapes.includes(messageShape(falsePinnedControl)),
    // No summarized message reached the model in raw form. Every
    // accounting field above would hold if the compactor summarized a
    // message correctly AND also copied it verbatim into the injected
    // summary — the raw history would still be consuming context.
    rawSummarizedInProjection: countRawSummarizedInProjection({
      before,
      summarizedIds,
      projectionText,
    }),
    // Makes the page's claim that ids are reassigned load-bearing. If
    // compaction started preserving them, every other field here would
    // stay green while the prose taught a contract that had changed.
    carriedIdOverlap: projection.filter((message) => seededIds.includes(message.id)).length,
    // Every chunk's summary reached the model, asserted as a boolean
    // rather than as a count — how many chunks compaction used is an
    // internal, whether it dropped one is not.
    allSummariesReachProjection: allSummariesReachProjection({ markers, projection }),
    summaryChunks: `${markers.filter((marker) => summaryText.includes(marker)).length} of ${markers.length}`,
    // Raw occurrences minus distinct ones. `distinctStrings` collapses a
    // message handed to `summarize` twice, so every count and the
    // partition stay correct while the summary double-counts context
    // and a real summarizer bills for the redundant work.
    duplicateSummarizerInputs: seenIds.length - distinctStrings(seenIds).length,
    summaryOrder,
    summariesInOrder,
    chunkRanges,
    chunksChronological,
    emptyChunks,
    everyMarkerOnce,
    markerOccurrences: markerCounts.join(', '),
    generateCalls,
    finishReason: result.finishReason,
    runError: errorNameOf(result.error),
    steps: result.steps.length,
    // Every message the summarizer saw matched the seeded message of
    // the same shape — role, content, and metadata alike.
    summarizerInputsIntact: summarizerInputsAreIntact({
      beforeShapes,
      seededIds,
      summarizerInputs,
    }),
  };
}
