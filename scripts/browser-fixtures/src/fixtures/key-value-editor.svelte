<script lang="ts">
  import { KeyValueEditor, type KeyValueEntry } from '@corvidae/cinder';

  let entries = $state<KeyValueEntry[]>([
    { key: 'HOST', value: 'localhost' },
    { key: 'PORT', value: '3000' },
  ]);
</script>

<KeyValueEditor bind:entries />
