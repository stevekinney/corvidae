<script lang="ts">
  import { ToolCallRail, type ToolCallRailCall } from '@lostgradient/cinder';

  const calls: ToolCallRailCall[] = [
    {
      id: 'linked',
      name: 'Lookup order',
      identifier: 'lookup-order',
      input: '4471',
      result: 'Open order',
      resultHref: '#linked-result',
      duration: '0.2s',
      status: 'done',
    },
    {
      id: 'waiting',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4472',
      duration: '0.3s',
      status: 'waiting',
    },
    {
      id: 'adjacent',
      name: 'Check inventory',
      identifier: 'check-inventory',
      input: 'MUG-04',
      result: '6 in stock',
      duration: '0.1s',
      status: 'done',
    },
  ];

  let selectedId = $state<string>();
</script>

<div class="fixture" data-testid="tool-call-rail-targets">
  <ToolCallRail {calls} bind:selectedId onSelect={(id) => (selectedId = id)} />
</div>

<style>
  .fixture {
    inline-size: 20rem;
    max-inline-size: 100%;
    padding: var(--cinder-space-4);
  }
</style>
