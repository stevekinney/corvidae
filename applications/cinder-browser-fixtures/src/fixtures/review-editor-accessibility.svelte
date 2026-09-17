<script lang="ts">
  import WithComments from './with-comments.svelte';
  import WithCommentsReadonly from './with-comments-readonly.svelte';
  import BasicReviewEditor from './review-editor-basic.svelte';
  import ScrollAndSidebar from './scroll-and-sidebar.svelte';
</script>

<main class="review-editor-accessibility-fixture">
  <BasicReviewEditor />
  <WithComments />
  <WithCommentsReadonly />
  <ScrollAndSidebar />
</main>
