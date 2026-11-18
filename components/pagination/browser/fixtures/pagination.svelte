<script lang="ts">
  import { default as Pagination } from '@lostgradient/pagination/components/pagination/index.ts';
  let currentPage = $state(1);
</script>

<Pagination bind:currentPage totalPages={10} />
<p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">Page {currentPage} of 10</p>
