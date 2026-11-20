<script lang="ts">
  import Segment from '../segment/segment.svelte';
  import { SegmentedControl } from './index.ts';

  type FixtureProps = {
    selected?: string;
    /** `narrow`: the sign-in choice in a 280px container, with a description or an error under it. */
    message?: 'description' | 'error' | undefined;
  };

  let { selected = 'rendered', message }: FixtureProps = $props();
</script>

{#if message === undefined}
  <div class="segmented-control-fixture">
    <SegmentedControl
      id="visual-fixture-view"
      selectionMode="single"
      value={selected}
      label="Document view"
    >
      <Segment value="source">Source</Segment>
      <Segment value="rendered">Rendered</Segment>
      <Segment value="diff">Diff</Segment>
    </SegmentedControl>
  </div>
{:else}
  <!-- A form section's grid cell: the options do not fit 280px, so the control stacks and the
       message wraps inside the container. -->
  <div class="segmented-control-fixture-narrow" data-testid="narrow-container">
    <SegmentedControl
      id="visual-fixture-sign-in"
      selectionMode="single"
      value="oauth"
      label="How it signs in"
      description={message === 'description'
        ? 'Approve in the GitHub window. Closing it cancels the sign-in.'
        : undefined}
      error={message === 'error'
        ? 'Couldn’t sign in. GitHub refused the request: the redirect address wasn’t allowed.'
        : undefined}
    >
      <Segment value="oauth">OAuth opens the provider</Segment>
      <Segment value="bearer">Bearer token</Segment>
      <Segment value="none">None</Segment>
    </SegmentedControl>
  </div>
{/if}

<style>
  .segmented-control-fixture {
    display: grid;
    gap: var(--cinder-space-3);
    justify-items: start;
  }

  .segmented-control-fixture-narrow {
    display: grid;
    inline-size: 280px;
  }
</style>
