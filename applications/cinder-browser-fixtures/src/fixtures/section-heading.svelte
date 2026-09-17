<script lang="ts">
  import { Button, SectionHeading } from '@repo/cinder';
</script>

<div id="example-mount-basic">
  <SectionHeading
    title="Project overview"
    description="Track the current milestone, recent activity, and next steps."
  >
    {#snippet actions()}
      <Button size="sm" variant="secondary" label="Share" />
    {/snippet}
  </SectionHeading>
</div>
