<script lang="ts">
  import type { SettingsAccess } from '../../../routes/settings/section-access.ts';
  import ConnectedAppsSettings from '../../../routes/settings/connected-apps/index.svelte';

  let { data }: { data: { access: SettingsAccess } } = $props();
</script>

<ConnectedAppsSettings initialAccess={data.access} documentPath="/settings/connected-apps" />
