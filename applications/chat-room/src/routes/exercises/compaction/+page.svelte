<script lang="ts">
  import { observe } from './compaction-observation.ts';

  const observation = observe();

  let settled = $state(false);
  void observation.then(() => {
    settled = true;
    return undefined;
  });
</script>

<main>
  <h1>Context management — compaction</h1>
  <p>
    The model sees a summarized projection; the page keeps the whole transcript. The pinned fact
    crosses that boundary because the preserve policy carries it; the first follow-up does not. What
    crosses does so unchanged in role, content, and metadata — but not in identity: compaction
    reassigns message ids, so nothing keyed to one survives the boundary.
  </p>

  <!--
		A concise, PERSISTENT status line rather than an `aria-live` region
		around the result tables. Announcing the tables read out the whole
		technical listing on resolution; this exists at mount (a live region
		inserted with its content announces unreliably) and says only that the
		run settled, leaving the tables to normal navigation.
	-->
  <p role="status" data-testid="compaction-status">
    {settled ? 'Compaction run settled.' : 'Compaction run in progress.'}
  </p>

  <section data-testid="compaction">
    {#await observation}
      <p data-testid="compaction-pending">Running…</p>
    {:then result}
      <h2>What the model saw</h2>
      <dl>
        <dt>projection length</dt>
        <dd data-testid="compaction-projection-length">{result.projectionLength}</dd>
        <dt>projection roles</dt>
        <dd data-testid="compaction-projection-roles">{result.projectionRoles}</dd>
        <dt>summary injected</dt>
        <dd data-testid="compaction-projection-summary">{result.projectionHasSummary}</dd>
        <dt>messages handed to <code>summarize</code></dt>
        <dd data-testid="compaction-summarized-messages">{result.summarizedMessages}</dd>
        <dt>of those, not from the seed</dt>
        <dd data-testid="compaction-foreign-messages">{result.foreignMessages}</dd>
        <dt>carried through unchanged (role, content, metadata)</dt>
        <dd data-testid="compaction-carried-unchanged">{result.carriedVerbatim}</dd>
        <dt>projection, mapped back to seed positions</dt>
        <dd data-testid="compaction-projection-order">{result.projectionOrder}</dd>
        <dt>in both buckets / in neither</dt>
        <dd data-testid="compaction-bucket-overlap">
          {result.inBothBuckets} / {result.inNeitherBucket}
        </dd>
        <dt>exact partition</dt>
        <dd data-testid="compaction-partition">{result.partitionExact}</dd>
        <dt><code>pinned</code> metadata survives</dt>
        <dd data-testid="compaction-pinned-metadata">{result.pinnedMetadataSurvives}</dd>
        <dt>unpinned message with metadata was summarized</dt>
        <dd data-testid="compaction-metadata-control">{result.metadataControlSummarized}</dd>
        <dt><code>pinned: false</code> message was summarized</dt>
        <dd data-testid="compaction-false-pinned-control">
          {result.falsePinnedControlSummarized}
        </dd>
        <dt>summarized messages reaching the model raw</dt>
        <dd data-testid="compaction-raw-summarized">{result.rawSummarizedInProjection}</dd>
        <dt>seed ids reused in the projection</dt>
        <dd data-testid="compaction-id-overlap">{result.carriedIdOverlap}</dd>
        <dt>chunk summaries reaching the model</dt>
        <dd data-testid="compaction-summary-chunks">{result.summaryChunks}</dd>
        <dt>every chunk summary survived</dt>
        <dd data-testid="compaction-summaries-survived">
          {result.allSummariesReachProjection}
        </dd>
        <dt>chunk summaries, in the order the model reads them</dt>
        <dd data-testid="compaction-summary-order">{result.summaryOrder}</dd>
        <dt>chunk summaries in callback order</dt>
        <dd data-testid="compaction-summaries-in-order">{result.summariesInOrder}</dd>
        <dt>seed positions per chunk</dt>
        <dd data-testid="compaction-chunk-ranges">{result.chunkRanges}</dd>
        <dt>chunks fed in chronological order</dt>
        <dd data-testid="compaction-chunks-chronological">{result.chunksChronological}</dd>
        <dt>empty chunks handed to <code>summarize</code></dt>
        <dd data-testid="compaction-empty-chunks">{result.emptyChunks}</dd>
        <dt>times each summary appears</dt>
        <dd data-testid="compaction-marker-occurrences">{result.markerOccurrences}</dd>
        <dt>every summary appears exactly once</dt>
        <dd data-testid="compaction-marker-once">{result.everyMarkerOnce}</dd>
        <dt>messages summarized more than once</dt>
        <dd data-testid="compaction-duplicate-inputs">{result.duplicateSummarizerInputs}</dd>
        <dt><code>generate</code> calls</dt>
        <dd data-testid="compaction-generate-calls">{result.generateCalls}</dd>
        <dt>summarizer input matched the seed</dt>
        <dd data-testid="compaction-summarizer-inputs">{result.summarizerInputsIntact}</dd>
        <dt>run finishReason / error / steps</dt>
        <dd data-testid="compaction-run-outcome">
          {result.finishReason} / {result.runError} / {result.steps}
        </dd>
        <dt>pinned fact present</dt>
        <dd data-testid="compaction-projection-pin">{result.projectionHasPin}</dd>
        <dt>first follow-up present</dt>
        <dd data-testid="compaction-projection-filler">{result.projectionHasFirstFiller}</dd>
      </dl>

      <h2>What this page still holds</h2>
      <dl>
        <dt>length before the run</dt>
        <dd data-testid="compaction-seeded-length-before">{result.seededLengthBefore}</dd>
        <dt>length after the run</dt>
        <dd data-testid="compaction-seeded-length-after">{result.seededLengthAfter}</dd>
        <dt>every message byte-identical</dt>
        <dd data-testid="compaction-seeded-identical">{result.seededIdentical}</dd>
        <dt>control: two reads agree</dt>
        <dd data-testid="compaction-seeded-control">{result.seededControlIdentical}</dd>
        <dt>control: projection differs</dt>
        <dd data-testid="compaction-projection-differs">{result.projectionDiffers}</dd>
        <dt>pinned fact present</dt>
        <dd data-testid="compaction-seeded-pin">{result.seededHasPin}</dd>
        <dt>first follow-up present</dt>
        <dd data-testid="compaction-seeded-filler">{result.seededHasFirstFiller}</dd>
      </dl>
    {/await}
  </section>
</main>

<style>
  main {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
    font-family: monospace;
  }

  /*
	 * At 320 CSS pixels, a `max-content` label column cannot shrink, so a long
	 * term like "carried through unchanged (role, content, metadata)" pushes
	 * the value column off-screen and a reader at high zoom has to pan
	 * sideways to pair a term with its value. Stack the list instead once
	 * there is no room for two columns.
	 */
  @media (max-width: 32rem) {
    dl {
      grid-template-columns: 1fr;
      gap: 0;
    }

    dt {
      margin-block-start: 0.75rem;
    }
  }
</style>
