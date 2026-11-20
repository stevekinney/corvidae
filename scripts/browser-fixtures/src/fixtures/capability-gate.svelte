<script lang="ts">
  import { Button, CapabilityGate } from '@lostgradient/cinder';
  import type { CapabilityGateState } from '@lostgradient/cinder';

  let capabilityState = $state<CapabilityGateState>('permission-needed');
  const needsAction = $derived(capabilityState === 'permission-needed');

  const states: CapabilityGateState[] = [
    'supported',
    'unsupported',
    'permission-needed',
    'permission-denied',
    'loading',
    'unavailable',
  ];
</script>

<div class="example-frame gap-4">
  {#if needsAction}
    <CapabilityGate feature="Microphone" state={capabilityState}>
      <p class="paragraph text-muted">
        Microphone access is needed for voice input. Your audio is never stored or shared.
      </p>

      {#snippet actions()}
        <Button
          size="sm"
          variant="primary"
          label="Allow microphone"
          onclick={() => {
            capabilityState = 'supported';
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          label="Use text instead"
          onclick={() => {
            capabilityState = 'unsupported';
          }}
        />
      {/snippet}
    </CapabilityGate>
  {:else}
    <CapabilityGate feature="Microphone" state={capabilityState} />
  {/if}

  <div class="example-layout gap-2">
    {#each states as s (s)}
      <Button
        size="sm"
        variant={capabilityState === s ? 'secondary' : 'ghost'}
        onclick={() => {
          capabilityState = s;
        }}
      >
        {s}
      </Button>
    {/each}
  </div>
</div>

<style>
  .example-frame {
    display: flex;
    flex-direction: column;
    max-width: 28rem;
  }

  .paragraph {
    font-size: var(--cinder-text-base);
    margin: 0;
  }

  .example-layout {
    display: flex;
    flex-wrap: wrap;
  }
</style>
