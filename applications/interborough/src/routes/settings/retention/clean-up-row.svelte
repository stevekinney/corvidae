<script lang="ts">
  /**
   * The Clean-up section's one row, "Remove expired records" (board PageSettingsSections, "Data and
   * retention" and "Row action result"; rows 50h and 50j). It says when the host does this each
   * night, when it last did and which night it was off for, and "Clean up now" is the row's own
   * action, not a page action. What a clean-up removed is reported on this row, and the button
   * stays so it can be pressed again.
   */
  import { Button, SettingRow } from '@lostgradient/cinder';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { DATA_RETENTION_COPY } from '../../../app/copy/settings.ts';
  import {
    cleanUpNow,
    getCleanUpStanding,
    type HostCleanUpRun,
  } from '../../../lib/host-clean-up.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { descriptionWords, resultWords, scheduleWords } from './clean-up-words.ts';

  const copy = DATA_RETENTION_COPY.cleanUp;
  const queryClient = useQueryClient();

  const standing = createQuery(
    () => ({
      queryKey: queryKeys.hostCleanUp(),
      queryFn: ({ signal }) => getCleanUpStanding({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** The clean-up this page ran, which the row reports until the page is left or another runs. */
  let run = $state<HostCleanUpRun | undefined>(undefined);

  const clean = createMutation(
    () => ({
      mutationFn: () => cleanUpNow(),
      onMutate: () => {
        run = undefined;
      },
      onSuccess: (finished: HostCleanUpRun) => {
        run = finished;
        void queryClient.invalidateQueries({ queryKey: queryKeys.hostCleanUp() });
      },
    }),
    undefined,
  );

  const result = $derived(run === undefined ? undefined : resultWords(run));

  /** The schedule alone once this page has cleaned up, because the result says the rest; else the whole description. */
  const description = $derived.by(() => {
    const known = standing.data;
    if (known === undefined) return undefined;
    return run === undefined ? descriptionWords(known, Date.now()) : scheduleWords(known);
  });
</script>

<div class="ib-clean-up" data-setting="clean-up" data-testid="clean-up">
  <SettingRow
    id="ib-clean-up"
    label={copy.label}
    {...description === undefined ? {} : { description }}
    {...clean.isPending
      ? { status: 'saving' as const, statusLabel: copy.working }
      : clean.isError
        ? { error: copy.failed, onRetry: () => clean.mutate(), retryLabel: copy.retry }
        : result === undefined
          ? {}
          : result.failed
            ? { error: result.text }
            : { status: 'saved' as const, statusLabel: result.text }}
    controlWidth="10rem"
  >
    {#snippet control()}
      <Button
        variant="secondary"
        size="sm"
        disabled={clean.isPending}
        data-changes
        aria-describedby="ib-clean-up-description"
        onclick={() => clean.mutate()}
      >
        {#snippet leadingIcon()}<Trash2 size={14} aria-hidden="true" />{/snippet}
        {copy.action}
      </Button>
    {/snippet}
  </SettingRow>
</div>

<style>
  .ib-clean-up {
    min-inline-size: 0;
  }
</style>
