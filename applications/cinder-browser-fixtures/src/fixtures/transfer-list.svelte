<script lang="ts">
  import { TransferList } from '@repo/cinder';

  const items = [
    { id: 'read', label: 'Read' },
    { id: 'write', label: 'Write' },
    { id: 'deploy', label: 'Deploy' },
    { id: 'billing', label: 'Billing', disabled: true },
  ];

  let value = $state(['read']);
</script>

<TransferList
  {items}
  bind:value
  leftLabel="Available permissions"
  rightLabel="granted permissions"
/>

<p>Granted: {value.join(', ') || 'None'}</p>
