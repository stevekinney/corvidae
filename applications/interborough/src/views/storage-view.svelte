<script lang="ts">
  /** `StorageView`: the storage area, renderable inside or outside the application shell. */
  import StorageRoute from '../routes/storage/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <StorageRoute />
</StandaloneView>
