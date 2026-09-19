<script lang="ts">
  import { Pagination } from '@corvidae/cinder';
  let currentPage = $state(1);
</script>

<Pagination bind:currentPage totalPages={10} />
<p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">Page {currentPage} of 10</p>
