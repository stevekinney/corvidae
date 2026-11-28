<script lang="ts">
  import type { SettingsAccess } from '../../../routes/settings/section-access.ts';
  import ApiKeys from '../../../routes/settings/api-keys/index.svelte';

  let { data }: { data: { keyAccess: SettingsAccess } } = $props();
</script>

<ApiKeys initialAccess={data.keyAccess} documentPath="/settings/api-keys" />
