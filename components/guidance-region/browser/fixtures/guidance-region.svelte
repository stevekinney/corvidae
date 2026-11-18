<script lang="ts">
  import { default as Button } from '@lostgradient/button/components/button/index.ts';
  import {
    default as GuidanceRegion,
    type GuidanceClaim,
    useGuidance,
  } from '@lostgradient/guidance-region/components/guidance-region/index.ts';

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
