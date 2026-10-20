<script lang="ts">
  /**
   * What an approval would run, as the policy evaluated it: a `command`, a `diff`, and the
   * `filesTouched`. An operator decides on this, so each part is shown in full and each is shown
   * only when the review carries it. A patch is shown with the source diff viewer when it parses as
   * a unified patch, and as a preformatted block when it does not, so it is never left out.
   */
  import { Button, CodeBlock, parseUnifiedPatch, SourceDiffViewer } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';

  interface BureauReviewOperationProps {
    readonly operation: {
      readonly command?: string | undefined;
      readonly diff?: string | undefined;
      readonly filesTouched?: readonly string[] | undefined;
    };
  }

  let { operation }: BureauReviewOperationProps = $props();

  /** The rows of a patch shown at first, which is the viewer's own default. */
  const DIFF_LINE_LIMIT = 1000;

  // A longer patch shows its first rows and the viewer's notice of how many there are, and the
  // operator can ask for the rest: an approval is decided on the whole patch, but a patch of
  // thousands of rows is not drawn until it is asked for.
  let showWholeDiff = $state(false);
  const lineLimit = $derived(showWholeDiff ? Number.MAX_SAFE_INTEGER : DIFF_LINE_LIMIT);
  const parsed = $derived(
    operation.diff === undefined
      ? undefined
      : parseUnifiedPatch(operation.diff, { maxLines: lineLimit }),
  );
  // A patch is a patch when it has a hunk: the parser takes any text as a file with one line, so
  // a file with no hunk is text that only looks like one.
  const parsesAsPatch = $derived(
    parsed !== undefined && parsed.descriptors.some((file) => file.hunkCount > 0),
  );
  // The same path twice (a patch with two hunks in one file) is one file.
  const files = $derived(Array.from(new Set(operation.filesTouched ?? [])));
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
        maxLines={lineLimit}
        ariaLabel={REVIEWS_COPY.operation.diff}
      />
      {#if parsed?.truncated}
        <Button
          variant="secondary"
          size="sm"
          label={REVIEWS_COPY.operation.showWholeDiff}
          onclick={() => (showWholeDiff = true)}
        />
      {/if}
    {:else}
      <pre class="weft-bureau-review-operation__diff">{operation.diff}</pre>
    {/if}
  </div>
{/if}

{#if files.length > 0}
  <div class="weft-bureau-review-operation">
    <span class="weft-bureau-review-operation__label">{REVIEWS_COPY.operation.filesTouched}</span>
    <ul class="weft-bureau-review-operation__files">
      {#each files as file (file)}
        <li><code>{file}</code></li>
      {/each}
    </ul>
  </div>
{/if}
