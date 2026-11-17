<script lang="ts">
  import PageHeader from '../page-header/page-header.svelte';
  import AppBar from './app-bar.svelte';

  let collapsed = $state(false);
</script>

<AppBar title="Runs" titleVisible={collapsed} back={{ href: '/' }} />
<PageHeader variant="large" title="Runs" bind:collapsed collapsedBar={false} />
