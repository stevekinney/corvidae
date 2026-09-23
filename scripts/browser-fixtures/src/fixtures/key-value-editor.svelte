<script lang="ts">
  import { KeyValueEditor, type KeyValueEntry } from '@lostgradient/cinder';

  let entries = $state<KeyValueEntry[]>([
    { id: 'host', key: 'HOST', value: 'localhost' },
    { id: 'port', key: 'PORT', value: '3000' },
  ]);
</script>

<KeyValueEditor bind:entries />
