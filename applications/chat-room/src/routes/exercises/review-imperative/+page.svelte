<script lang="ts">
  import ContentReplacementFixture from './content-replacement-fixture.svelte';
  import MutationFixture from './mutation-fixture.svelte';
  import ScrollFixture from './scroll-fixture.svelte';
  import type { Outcome, RecordDetail } from './imperative-utilities';

  let contentFixture = $state<ReturnType<typeof ContentReplacementFixture>>();
  let mutationFixture = $state<ReturnType<typeof MutationFixture>>();

  function record(name: string, outcome: Outcome, result: unknown, detail?: RecordDetail): void {
    mutationFixture?.record(name, outcome, result, detail);
  }
</script>

<div style="max-width: 60rem; margin: 0 auto; padding: 2rem 1rem; display: grid; gap: 1.5rem;">
  <header>
    <h1>Review Imperative</h1>
    <p>
      Drives the eight thread and comment mutation methods through <code>bind:this</code>, against
      an editable and a <code>readonly</code> instance, plus
      <code>setMarkdown</code>/<code>reset</code>/<code>getMarkdown</code>/<code>getAst</code> on a
      third instance and <code>scrollToThread</code>/<code>getEditor</code> on a fourth.
    </p>
  </header>

  <MutationFixture bind:this={mutationFixture} />
  <ContentReplacementFixture bind:this={contentFixture} {record} />
  <ScrollFixture {record} getOtherEditor={() => contentFixture?.getEditorHandle()} />
</div>
