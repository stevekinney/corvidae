<script lang="ts">
  import { Citation } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';

  import {
    initialClaimStream,
    reduceClaimStream,
    viewPositional,
    viewStructured,
    type ClaimSourceFixtureProps,
    type ClaimStreamEvent,
    type ClaimStreamState,
  } from './claim-source-fixture.ts';

  let { representation }: ClaimSourceFixtureProps = $props();

  let stream = $state.raw<ClaimStreamState>(initialClaimStream());

  /** Feeds one event of the replay. */
  export function dispatch(event: ClaimStreamEvent): void {
    stream = reduceClaimStream(stream, event);
  }

  const view = $derived(
    representation === 'structured' ? viewStructured(stream) : viewPositional(stream),
  );
  const sourcesById = $derived(new Map(stream.sources.map((source) => [source.id, source])));
</script>

<div class="claim-source-fixture" data-representation={representation}>
  <div class="claim-source-body" data-testid="claim-source-body">
    {#each view.segments as segment, index (index)}
      {#if /^\s/.test(segment.markdown)}{' '}{/if}<span class="claim-source-segment"
        >{@html renderMarkdown(segment.markdown).html}</span
      >{#if segment.marker}{@const source = sourcesById.get(
          segment.marker.sourceId,
        )}{#if source}<span
            class="claim-source-marker"
            data-claim-marker={segment.marker.key}
            data-source-id={source.id}
            ><Citation sources={[source]} label={source.label}
              ><span
                class="claim-source-marker-number"
                data-number={segment.marker.number}
                aria-hidden="true"
              ></span></Citation
            ></span
          >{/if}{/if}
    {/each}
  </div>

  {#if view.footer.length > 0}
    <ol class="claim-source-footer" aria-label="Sources" data-testid="claim-source-footer">
      {#each view.footer as source (source.id)}
        <li data-source-entry={source.id}>
          <Citation sources={[source]} label={source.label}>{source.label}</Citation>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  /* The segments read as one paragraph: each claim's Markdown stays inline with its neighbours. */
  .claim-source-segment {
    display: inline;
  }

  .claim-source-segment :global(p) {
    display: inline;
    margin: 0;
  }

  /* The marker's number is generated content, so a selection or a copy never includes it. */
  .claim-source-marker-number::before {
    content: '[' attr(data-number) ']';
  }

  .claim-source-footer {
    margin: var(--cinder-space-3) 0 0;
    padding-inline-start: var(--cinder-space-5);
  }
</style>
