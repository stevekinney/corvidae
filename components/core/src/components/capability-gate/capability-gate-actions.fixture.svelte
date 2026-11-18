<script lang="ts">
  import { Button } from '../button/index.ts';
  import { CapabilityGate } from './index.ts';
  import type { CapabilityGateState } from './capability-gate.types.ts';

  // The gate on each of its tints (default, warning, error, success), each with a primary and a
  // secondary Button, beside a primary Button on the page, so a test can compare the two.
  const states: CapabilityGateState[] = [
    'unavailable',
    'permission-needed',
    'permission-denied',
    'supported',
  ];
</script>

<div class="capability-gate-actions">
  <div data-testid="reference"><Button variant="primary" size="sm" label="Reference" /></div>
  {#each states as state (state)}
    <div data-testid={state}>
      <CapabilityGate feature="Microphone" {state}>
        {#snippet actions()}
          <Button variant="primary" size="sm" label="Allow microphone" />
          <Button variant="secondary" size="sm" label="Use text instead" />
        {/snippet}
      </CapabilityGate>
    </div>
  {/each}
</div>

<style>
  .capability-gate-actions {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-inline-size: 28rem;
  }
</style>
