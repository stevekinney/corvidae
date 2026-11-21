<script lang="ts">
  import { Button } from '../button/index.ts';
  import { Toggle } from '../toggle/index.ts';
  import { FormActions } from './index.ts';

  let a2a = $state(false);
</script>

{#snippet start30()}
  <div class="form-actions-summary__a2a">
    <Toggle id="form-actions-summary-a2a-30rem" label="Available over A2A" bind:checked={a2a} />
    <p class="form-actions-summary__note">
      Lets other agents and A2A clients find and call this agent. Chats with it work either way.
    </p>
  </div>
{/snippet}

{#snippet start45()}
  <div class="form-actions-summary__a2a">
    <Toggle id="form-actions-summary-a2a-45rem" label="Available over A2A" bind:checked={a2a} />
    <p class="form-actions-summary__note">
      Lets other agents and A2A clients find and call this agent. Chats with it work either way.
    </p>
  </div>
{/snippet}

{#snippet summary()}
  <span data-testid="saved-summary">Saved, Version 1</span>
{/snippet}

{#snippet longSummary()}
  <span data-testid="long-summary">
    Connect is off while Interborough can’t be reached. The selected tools will stay in this form
    while you check whether the host is available.
  </span>
{/snippet}

{#snippet end()}
  <Button type="button" variant="ghost" label="Cancel" />
  <Button type="button" variant="primary" label="Save" />
{/snippet}

<div class="form-actions-summary">
  <div class="form-actions-summary__bar" data-testid="form-actions-30rem">
    <FormActions {summary} start={start30} {end} />
  </div>
  <div class="form-actions-summary__bar" data-testid="form-actions-45rem">
    <FormActions {summary} start={start45} {end} />
  </div>
  <div class="form-actions-summary__bar" data-testid="form-actions-long-summary">
    <FormActions summary={longSummary} {end} />
  </div>
</div>

<style>
  .form-actions-summary {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .form-actions-summary__a2a {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
  }

  .form-actions-summary__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
