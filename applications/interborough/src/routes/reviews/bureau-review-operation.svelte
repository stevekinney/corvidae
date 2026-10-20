<script lang="ts">
  /**
   * What an approval would run, as the policy evaluated it: a `command`, a `diff`, and the
   * `filesTouched`. An operator decides on this, so each part is shown in full and each is shown
   * only when the review carries it. A patch is shown with the source diff viewer when it parses as
   * a unified patch, and as a preformatted block when it does not, so it is never left out.
   */
  import { CodeBlock, parseUnifiedPatch, SourceDiffViewer } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';

  interface BureauReviewOperationProps {
    readonly operation: {
      readonly command?: string | undefined;
      readonly diff?: string | undefined;
      readonly filesTouched?: readonly string[] | undefined;
    };
  }

  let { operation }: BureauReviewOperationProps = $props();

  // A patch is a patch when it has a hunk: the parser takes any text as a file with one line, so
  // a file with no hunk is text that only looks like one. `maxLines` is lifted so an operator never
  // approves a patch whose end was cut off.
  const parsesAsPatch = $derived(
    operation.diff !== undefined &&
      parseUnifiedPatch(operation.diff, { maxLines: Number.MAX_SAFE_INTEGER }).descriptors.some(
        (file) => file.hunkCount > 0,
      ),
  );
</script>

{#if operation.command !== undefined}
  <div class="weft-bureau-review-operation">
    <span class="weft-bureau-review-operation__label">{REVIEWS_COPY.operation.command}</span>
    <CodeBlock code={operation.command} languageLabelVisible={false} copyable />
  </div>
{/if}

{#if operation.diff !== undefined}
  <div class="weft-bureau-review-operation">
    <span class="weft-bureau-review-operation__label">{REVIEWS_COPY.operation.diff}</span>
    {#if parsesAsPatch}
      <SourceDiffViewer
        patch={operation.diff}
        maxLines={Number.MAX_SAFE_INTEGER}
        ariaLabel={REVIEWS_COPY.operation.diff}
      />
    {:else}
      <pre class="weft-bureau-review-operation__diff">{operation.diff}</pre>
    {/if}
  </div>
{/if}

{#if operation.filesTouched !== undefined && operation.filesTouched.length > 0}
  <div class="weft-bureau-review-operation">
    <span class="weft-bureau-review-operation__label">{REVIEWS_COPY.operation.filesTouched}</span>
    <ul class="weft-bureau-review-operation__files">
      {#each operation.filesTouched as file (file)}
        <li><code>{file}</code></li>
      {/each}
    </ul>
  </div>
{/if}
