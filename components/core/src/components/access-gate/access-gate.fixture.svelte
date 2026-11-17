<script lang="ts">
  import { Button } from '../button/index.ts';

  import { AccessGate } from './index.ts';

  type Props = {
    variant?: 'inline' | 'inline-granted' | 'inline-toggle' | 'section' | 'page';
  };

  let { variant = 'inline' }: Props = $props();
  let toggleGranted = $state(false);
</script>

{#if variant === 'section'}
  <AccessGate
    granted={false}
    variant="section"
    reason="Requires scope: storage:admin"
    requirement="storage:admin"
  />
{:else if variant === 'page'}
  <AccessGate
    granted={false}
    variant="section"
    layout="page"
    headingLevel={1}
    title="Your sign-in can’t open Hooks"
    reason="Settings › API reference › Your scopes shows what it can do."
    requirement="hooks:read"
  >
    {#snippet actions()}
      <Button label="See your scopes" />
      <Button label="Back to Home" />
    {/snippet}
  </AccessGate>
{:else if variant === 'inline-granted'}
  <span data-access-gate-baseline><Button label="Cancel workflow" variant="danger" /></span>
  <AccessGate granted={true} reason="Requires scope: workflows:cancel">
    <Button label="Cancel workflow" variant="danger" />
  </AccessGate>
{:else if variant === 'inline-toggle'}
  <Button
    label="Toggle access"
    size="sm"
    onclick={() => {
      toggleGranted = !toggleGranted;
    }}
  />
  <span data-access-gate-toggle-anchor>
    <AccessGate granted={toggleGranted} reason="Requires scope: workflows:cancel">
      <Button label="Cancel workflow" variant="danger" />
    </AccessGate>
  </span>
{:else}
  <AccessGate granted={false} reason="Requires scope: workflows:cancel">
    <Button label="Cancel workflow" variant="danger" />
  </AccessGate>
{/if}
