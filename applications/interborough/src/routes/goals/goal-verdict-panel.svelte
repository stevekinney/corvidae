<script lang="ts">
  /**
   * One attempt's verdict (COR-2124), in a drawer opened from the attempt's row: it opens with the
   * row's status dot and word (what the check decided), then what the check said was wrong (a
   * paragraph, when it said anything), the check itself in words with its name, version and source
   * beneath (and the settings it was given, in its words), and what it showed as evidence (only
   * when it showed any). A read that failed offers Try again. It reads `bureau.goals.verdict` when it opens, and each kind of answer has its own
   * words: an attempt with no verdict yet says "Not judged yet", and the verdict of a goal the viewer
   * does not own, which the Bureau answers as missing without a content scope, says it is private.
   * Every rule for which words is in `goal-verdict-rows.ts`.
   */
  import {
    Button,
    Callout,
    Drawer,
    DescriptionList,
    JsonViewer,
    Skeleton,
    StatusDot,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { GOALS_COPY } from '../../app/copy/goals.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { wireCodeOf } from '../../lib/bureau-client.ts';
  import { getGoalVerdict } from '../../lib/bureau-goals.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    verdictFacts,
    verdictFailure,
    verdictWord,
    type VerdictFailure,
  } from './goal-verdict-rows.ts';

  interface Props {
    /** The goal whose attempt is read. */
    goalRunId: string;
    /** The goal's owner of record, which a viewer who is not it cannot read the verdict of. */
    owner: string;
    /** Who is looking, or `undefined`/`null` when the host names no principal. */
    viewer: string | null | undefined;
    /** The attempt whose verdict is open (its `attemptIndex`), or `undefined` while none is. */
    attemptIndex: number | undefined;
    /** Closes the panel. */
    onClose: () => void;
  }

  let { goalRunId, owner, viewer, attemptIndex, onClose }: Props = $props();

  const copy = GOALS_COPY.detail.verdict;
  // The drawer owns its own open state (it closes itself on Escape and on its Close), and follows
  // the attempt the page names; `onClose` tells the page it is shut.
  let open = $state(false);
  // The last attempt that was open, so the panel keeps its words while it slides closed.
  let shown = $state<number>(0);
  $effect(() => {
    if (attemptIndex !== undefined) shown = attemptIndex;
    open = attemptIndex !== undefined;
  });
  // The drawer closes itself (Escape, its Close, the backdrop) by setting `open`, so the page is
  // told it is shut when `open` goes from true to false.
  let wasOpen = false;
  $effect(() => {
    if (open) {
      wasOpen = true;
    } else if (wasOpen) {
      wasOpen = false;
      onClose();
    }
  });

  const verdict = createQuery(() => ({
    queryKey: queryKeys.goals.verdict(goalRunId, shown),
    queryFn: ({ signal }: { signal: AbortSignal }) => getGoalVerdict(goalRunId, shown, { signal }),
    enabled: open,
    retry: false,
  }));

  const failure: VerdictFailure | undefined = $derived(
    verdict.isError ? verdictFailure(wireCodeOf(verdict.error), { owner, viewer }) : undefined,
  );
  const facts = $derived(verdict.data === undefined ? [] : verdictFacts(verdict.data));
</script>

<Drawer
  bind:open
  title={copy.title(shown + 1)}
  closeLabel={copy.closeLabel}
  size="md"
  data-testid="goal-verdict"
>
  {#if verdict.data !== undefined}
    {@const found = verdict.data}
    {@const said = found.outcome === 'pass' ? found.reason : found.feedback}
    <div class="ib-goal-verdict" data-testid="goal-verdict-body" data-outcome={found.outcome}>
      <!-- The verdict opens with what the attempt's row opens with: the dot and the word. -->
      <StatusDot word={verdictWord(found.outcome)} data-testid="goal-verdict-status" />
      <!-- What the check said: a missed check's feedback, or why a met one was met (row 67v). -->
      {#if said !== null && said !== ''}
        <p class="ib-goal-verdict__feedback" data-testid="goal-verdict-feedback">
          {said}
        </p>
      {/if}
      <DescriptionList items={facts} variant="fields" data-testid="goal-verdict-facts" />
      {#if found.evidence.length > 0}
        <section class="ib-goal-verdict__section" aria-labelledby={`verdict-${shown}-evidence`}>
          <h3 class="ib-goal-verdict__heading" id={`verdict-${shown}-evidence`}>
            {copy.evidenceTerm}
          </h3>
          <JsonViewer value={found.evidence} initialDepth={3} />
        </section>
      {/if}
    </div>
  {:else if failure !== undefined}
    {@const said = failure}
    {#snippet words()}<strong>{said.title}</strong> {said.message}{/snippet}
    {#if said.reason === 'unreadable'}
      <!-- A read that failed can be tried again from here, not by closing the panel. -->
      <Callout
        variant={said.tone}
        semantic="note"
        data-testid="goal-verdict-note"
        data-reason={said.reason}
      >
        {@render words()}
        {#snippet action()}
          <Button
            variant="secondary"
            size="sm"
            data-testid="goal-verdict-retry"
            onclick={() => void verdict.refetch()}>{RETRY_LABEL}</Button
          >
        {/snippet}
      </Callout>
    {:else}
      <Callout
        variant={said.tone}
        semantic="note"
        data-testid="goal-verdict-note"
        data-reason={said.reason}
      >
        {@render words()}
      </Callout>
    {/if}
  {:else if open}
    <Skeleton variant="list" rows={3} label={copy.loading} delay={300} />
  {/if}
</Drawer>

<style>
  .ib-goal-verdict {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-inline-size: 0;
  }

  .ib-goal-verdict__section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  .ib-goal-verdict__heading {
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: var(--cinder-font-semibold);
  }

  .ib-goal-verdict__feedback {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
