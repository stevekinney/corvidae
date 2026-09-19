<script lang="ts">
  import { SelectableRow } from '@corvidae/cinder';

  let opened = $state(0);
  let renamed = $state(0);
</script>

<SelectableRow
  selected
  onclick={() => {
    opened += 1;
  }}
>
  {#snippet leading()}<span aria-hidden="true">●</span>{/snippet}
  {#snippet title()}Customer onboarding workflow{/snippet}
  {#snippet description()}Inspect the active workflow execution and event history.{/snippet}
  {#snippet meta()}Running · Updated 2 minutes ago{/snippet}
  {#snippet trailingActions()}
    <button type="button" onclick={() => (renamed += 1)}>Rename</button>
    <a href="https://example.com/temporal/session">Temporal Web</a>
  {/snippet}
</SelectableRow>

<output data-testid="selectable-row-activation-counts">
  Opened {opened} times; renamed {renamed} times.
</output>
