<script lang="ts">
  import { Button, GuidanceRegion, type GuidanceClaim, useGuidance } from '@corvidae/cinder';

  const claims = [
    { id: 'welcome', anchor: 'workspace-start', content: 'Start by exploring the workspace.' },
  ] satisfies GuidanceClaim[];
  let anchor: HTMLElement;
</script>

<GuidanceRegion {claims} version="1.0.0" anchorResolver={() => anchor}>
  {#snippet children()}
    {@const guidance = useGuidance()}
    <span bind:this={anchor} id="workspace-start">
      <Button onclick={() => guidance.claim('welcome')}>Show welcome guidance</Button>
    </span>
  {/snippet}
</GuidanceRegion>
