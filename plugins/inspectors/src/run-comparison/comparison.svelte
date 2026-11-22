<script lang="ts">
  /**
   * The run comparison (COR-2544): a fork beside the run it came from, drawn with Cinder through the
   * panel kit. The steps the fork kept are the same as the source's and collapsed; the steps it ran
   * again are a Cinder `ListDetail` of `SelectableRow`s, each marked changed, the same, or in one run
   * only; opening one shows its input and output differences in `JsonDiffViewer`, beside the list
   * when the panel is wide and under it when it is narrow. The run page draws the same comparison
   * from the same components. Values go in as text, never as markup. A run the server will not
   * compare, such as one that is not a fork, shows the server's own message.
   *
   * The panel runs in a frame that can neither read storage nor change an address, so the list keeps
   * its selection in the view, never in the URL, and remembers no divider width.
   */
  import {
    Badge,
    Callout,
    Collapsible,
    ListDetail,
    SelectableRow,
    Text,
  } from '@lostgradient/cinder';
  import { JsonDiffViewer } from '@lostgradient/cinder/panel';

  import { KIND_WORDS, stepDetail, type StepRow } from './model.ts';
  import type { ComparisonView } from './view.svelte.ts';

  let { view }: { view: ComparisonView } = $props();

  /**
   * Below this width in pixels the detail sits under the list. The shared page width cap (40rem) is
   * under it, so in the panel the detail is always under the list, as on a phone.
   */
  const STACK_BELOW = 720;

  const model = $derived(view.model);

  const BADGE = {
    shared: 'neutral',
    changed: 'warning',
    unchanged: 'neutral',
    'source-only': 'info',
    'fork-only': 'accent',
  } as const;

  /** `ListDetail` keys are text; a step's key is its index. */
  function keyOf(row: StepRow): string {
    return String(row.index);
  }
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
          ? '1 step the same as the source'
          : `${String(model.shared.length)} steps the same as the source`}
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
      <ListDetail
        items={[...model.ranAgain]}
        key={keyOf}
        label="Steps the fork ran again"
        detailLabel="Step differences"
        selectionParameter={null}
        pushBelow={0}
        stackBelow={STACK_BELOW}
        bind:selectedKey={
          () => (view.selectedIndex === undefined ? null : String(view.selectedIndex)),
          (key) => (view.selectedIndex = key === null ? undefined : Number(key))
        }
      >
        {#snippet header()}
          <Text as="h2" variant="h4">Steps after the fork point</Text>
        {/snippet}
        {#snippet list(row, context)}
          {#snippet differs()}{row.differs}{/snippet}
          <SelectableRow
            selected={context.selected}
            selectedState="current"
            onclick={context.open}
            data-compared-step={row.index}
            data-kind={row.kind}
            {...row.differs === undefined ? {} : { description: differs }}
          >
            {#snippet title()}<span class="comparison-mono">{row.title}</span>{/snippet}
            {#snippet meta()}
              <Badge variant={BADGE[row.kind]} size="sm">{KIND_WORDS[row.kind]}</Badge>
            {/snippet}
          </SelectableRow>
        {/snippet}
        {#snippet empty()}
          <div class="comparison-detail">
            <Text as="h2" variant="h4">Select a step</Text>
            <p class="comparison-note">
              Choose a step to read what differs between the source and the fork.
            </p>
          </div>
        {/snippet}
        {#snippet detail(row)}
          {@const read = stepDetail(row.step)}
          <div class="comparison-detail">
            <Text as="h2" variant="h4">{read.heading}</Text>
            {#each read.notes as note (note)}
              <p class="comparison-note">{note}</p>
            {/each}
            {#each read.payloads as payload (payload.heading)}
              <div class="comparison-payload">
                <Text as="h3" variant="h5">{payload.heading}</Text>
                {#if payload.kind === 'note'}
                  <p class="comparison-note">{payload.note}</p>
                {:else}
                  <JsonDiffViewer
                    before={payload.before}
                    after={payload.after}
                    label={`${payload.heading} differences, step ${String(read.index + 1)}`}
                  />
                {/if}
              </div>
            {/each}
          </div>
        {/snippet}
      </ListDetail>
    {/if}
  </main>
{/if}
