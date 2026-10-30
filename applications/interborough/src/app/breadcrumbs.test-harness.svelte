<script lang="ts">
  /** Test-only page that supplies a breadcrumb label while mounted. Never imported by production code. */
  import { usePageLabel } from './breadcrumbs.svelte.ts';

  interface BreadcrumbHarnessProps {
    path: string;
    label: string | undefined;
  }

  let { path, label }: BreadcrumbHarnessProps = $props();

  usePageLabel(() => ({ path, label }));
</script>
