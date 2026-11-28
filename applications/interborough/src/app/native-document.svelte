<script lang="ts">
  import { getNavigationState } from '@lostgradient/velveteen/navigation';
  import { onDestroy } from 'svelte';
  import { router } from '../lib/router.svelte.ts';
  import '../styles/index.css';
  import App from './app.svelte';

  onDestroy(router.bindNative(getNavigationState()));
</script>

<App />
