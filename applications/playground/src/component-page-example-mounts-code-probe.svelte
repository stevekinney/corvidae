<!--
  Test-only probe standing in for an example scenario that renders a
  `CodeBlock` with a language and no `highlighter` prop. Used by
  `component-page-example-mounts.test.ts` to prove that the real
  `mountScenario` mounts examples beneath the playground's curated
  code-highlighter context.
-->
<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';

  type Props = { mountIdPrefix?: string };
  const { mountIdPrefix = '' }: Props = $props();
</script>

<div class="example-mounts-code-probe" data-mount-id-prefix={mountIdPrefix}>
  <CodeBlock code="SELECT 1;" language="sql" />
</div>
