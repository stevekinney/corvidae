<!--
  Root of every fixture the browser-fixture host mounts. CodeBlock imports no
  highlighter of its own since COR-1456, so a component that highlights through
  `setCodeHighlighterContext` (ApprovalCard's command, RunStepTimeline) renders
  the plain fallback unless an ancestor publishes one. The playground's fixture
  roots publish their curated adapter; this host publishes the full-registry
  adapter, the highlighter CodeBlock fell back to when the committed Linux
  baselines were rendered. It renders `component` with `componentProps`, adding
  no element of its own.
-->
<script lang="ts">
  import { fullShikiHighlighter, setCodeHighlighterContext } from '@lostgradient/cinder';
  import type { Component } from 'svelte';

  type Props = {
    component: Component<any>;
    componentProps: Record<string, any>;
  };

  let { component: Child, componentProps }: Props = $props();

  setCodeHighlighterContext(fullShikiHighlighter());
</script>

<Child {...componentProps} />
