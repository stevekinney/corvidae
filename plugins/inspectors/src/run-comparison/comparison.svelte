<script lang="ts">
  /**
   * The run comparison (COR-2544): a fork beside the run it came from, drawn with Cinder through the
   * panel kit. The steps the fork kept are shared and collapsed; the steps it ran again are a list,
   * each marked changed, the same, or in one run only; opening one shows its input and output
   * differences in `JsonDiffViewer`. Values go in as text, never as markup. A run the server will not
   * compare, such as one that is not a fork, shows the server's own message.
   */
  import { Badge, Callout, Collapsible, Text } from '@lostgradient/cinder';
  import { JsonDiffViewer } from '@lostgradient/cinder/panel';

  import { KIND_WORDS, stepDetail } from './model.ts';
  import type { ComparisonView } from './view.svelte.ts';

  let { view }: { view: ComparisonView } = $props();

  const model = $derived(view.model);
  const selected = $derived(model?.ranAgain.find((row) => row.index === view.selectedIndex)?.step);
  const detail = $derived(selected === undefined ? undefined : stepDetail(selected));

  const BADGE = {
    shared: 'neutral',
    changed: 'warning',
    unchanged: 'neutral',
    'source-only': 'info',
    'fork-only': 'accent',
  } as const;
</script>

{#if view.phase === 'loading'}
  <p role="status" aria-live="polite" class="panel-status">Reading the comparison…</p>
{:else if view.phase === 'failed'}
  <p role="status" aria-live="polite" class="panel-status">The comparison could not be read.</p>
{:else if view.phase === 'message'}
  <main class="panel-page">
    <Text as="h1" variant="h3">Run comparison</Text>
    <Callout variant="info">
      <p role="status" aria-live="polite" data-comparison-message>{view.message}</p>
    </Callout>
  </main>
{:else if model}
  <main class="panel-page">
    <Text as="h1" variant="h3">{model.title}</Text>
    <p class="comparison-note">{model.intro}</p>

    {#if model.shared.length > 0}
      <Collapsible
        variant="flat"
        trigger={model.shared.length === 1
          ? '1 step shared with the source'
          : `${String(model.shared.length)} steps shared with the source`}
      >
        <p class="comparison-note">
          The fork kept the source’s result for these steps and did not run them again.
        </p>
        <ul class="comparison-shared">
          {#each model.shared as row (row.index)}
            <li data-shared-step={row.index}>
              <span class="comparison-mono">{row.title}</span>
              <Badge variant="neutral" size="sm">{KIND_WORDS.shared}</Badge>
            </li>
          {/each}
        </ul>
      </Collapsible>
    {/if}

    {#if model.ranAgain.length === 0}
      <p class="panel-status" role="status">Neither run has any steps after the fork point yet.</p>
    {:else}
      <div class="comparison-layout">
        <section aria-labelledby="comparison-steps-heading">
          <Text as="h2" variant="h4" id="comparison-steps-heading">Steps after the fork point</Text>
          <ul class="comparison-steps">
            {#each model.ranAgain as row (row.index)}
              <li>
                <button
                  type="button"
                  class="comparison-row"
                  data-compared-step={row.index}
                  data-kind={row.kind}
                  aria-pressed={view.selectedIndex === row.index}
                  onclick={() => (view.selectedIndex = row.index)}
                >
                  <span class="comparison-mono comparison-row__title">{row.title}</span>
                  <Badge variant={BADGE[row.kind]} size="sm">{KIND_WORDS[row.kind]}</Badge>
                  {#if row.differs}<span class="comparison-row__detail">{row.differs}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </section>

        <section aria-labelledby="comparison-detail-heading" class="comparison-detail">
          {#if detail === undefined}
            <Text as="h2" variant="h4" id="comparison-detail-heading">Select a step</Text>
            <p class="comparison-note">
              Choose a step to read what differs between the source and the fork.
            </p>
          {:else}
            <Text as="h2" variant="h4" id="comparison-detail-heading">{detail.heading}</Text>
            {#each detail.notes as note (note)}
              <p class="comparison-note">{note}</p>
            {/each}
            {#each detail.payloads as payload (payload.heading)}
              <div class="comparison-payload">
                <Text as="h3" variant="h5">{payload.heading}</Text>
                {#if payload.kind === 'note'}
                  <p class="comparison-note">{payload.note}</p>
                {:else}
                  <JsonDiffViewer
                    before={payload.before}
                    after={payload.after}
                    label={`${payload.heading} differences, step ${String(detail.index + 1)}`}
                  />
                {/if}
              </div>
            {/each}
          {/if}
        </section>
      </div>
    {/if}
  </main>
{/if}
