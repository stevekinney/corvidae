<script lang="ts">
  import { Pagination } from '@lostgradient/cinder';
  let currentPage = $state(1);
</script>

<Pagination bind:currentPage totalPages={10} />
<p class="margin-block-start-2 text-muted">
  Page {currentPage} of 10
</p>
