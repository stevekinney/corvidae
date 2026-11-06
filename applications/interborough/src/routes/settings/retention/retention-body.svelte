<script lang="ts">
  /**
   * The body of Settings › Data and retention (board PageSettingsSections, "Data and retention";
   * rows 50d to 50g): the restart notice every section shares, a Retention section of four rows
   * (audit records, run history, chats and memory), each a choice between Keep forever and
   * Delete after and a number of days, a Storage section with the one read-only "Space used"
   * row, and a Clean-up section with the one row "Remove expired records" and its "Clean up now"
   * action (rows 50h and 50j). Each row saves as it is left and says so on its own row, and the
   * heading says "Saved just now" once any has. The other retention windows the Bureau has
   * (`retention.events`, `.tasks` and so on) are not drawn on the board, so they follow in a section
   * of their own, which keeps Retention to its four rows. A window reads like the four, with the
   * same choice and days, so every row has one label style; a setting that is no window
   * (`retention.checkpoints`) is drawn as the schema says. A window nothing stored a value for
   * shows the one in force (`effective`), so events kept for seven days do not read as kept forever.
   */
  import { FormSection } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { DATA_RETENTION_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
  import type { SettingsSchema, SettingsSnapshot } from '../../../lib/bureau-settings.ts';
  import SettingField from '../setting-field.svelte';
  import { inSection, settingLabel } from '../settings-controls.ts';
  import { SettingsSession } from '../settings-session.svelte.ts';
  import SettingsRestartNotice from '../settings-restart-notice.svelte';
  import RetentionWindowField from './retention-window-field.svelte';
  import {
    isRetentionRowKey,
    isRetentionWindowNode,
    RETENTION_ROW_KEYS,
    retentionProblemWith,
  } from './retention-window.ts';
  import CleanUpRow from './clean-up-row.svelte';
  import StorageUsageRow from './storage-usage-row.svelte';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
    /** Puts a status at the right of the page heading, or takes it away. */
    setHeaderStatus: (status: string | undefined) => void;
  }

  let { schema, snapshot, setHeaderStatus }: Props = $props();

  const copy = DATA_RETENTION_COPY;
  const queryClient = useQueryClient();

  // The schema never changes while the page is open (the frame reads it once), so it is taken as it is now.
  const session = new SettingsSession({
    schema: untrack(() => schema),
    snapshot: () => snapshot,
    queryClient,
    // The days a window may name are the page's to check: the schema only says it is a duration.
    extraCheck: (key, value) =>
      isRetentionRowKey(key) || isRetentionWindowNode(untrack(() => schema[key]))
        ? retentionProblemWith(value)
        : undefined,
  });
  const { form, autosave, revert, restartFlow } = session;

  $effect(() => {
    setHeaderStatus(autosave.anySaved ? copy.saved : undefined);
  });

  /** The rows the page draws, in its order, for the keys this Bureau has. */
  const rows = $derived(RETENTION_ROW_KEYS.filter((key) => schema[key] !== undefined));

  /** The retention settings the board draws no row for, which follow in their own section. */
  const extraKeys = $derived(
    Object.keys(schema).filter(
      (key) =>
        inSection(key, 'retention') && !(RETENTION_ROW_KEYS as readonly string[]).includes(key),
    ),
  );

  /** Whether a window has a `'forever'` to store: every retention key that takes `'forever'` in its schema. */
  function foreverOf(key: string): 'forever' | undefined {
    const options = schema[key]?.anyOf ?? [];
    return options.some((option) => option.const === 'forever') ? 'forever' : undefined;
  }

  function change(key: string, next: unknown): void {
    autosave.clear(key);
    revert.forget(key);
    form.set(key, next);
  }
</script>

{#snippet windowRow(key: string)}
  {@const node = schema[key]}
  {@const control = session.controls.get(key)}
  {#if node !== undefined && control !== undefined}
    {#snippet windowField(fieldProps: { id: string; disabled: boolean })}
      <RetentionWindowField
        id={fieldProps.id}
        name={copy.labels[key] ?? settingLabel(key)}
        value={form.draft(key) ?? snapshot.effective[key]}
        forever={foreverOf(key)}
        disabled={fieldProps.disabled}
        invalid={autosave.stateOf(key)?.phase === 'invalid'}
        onChange={(next) => change(key, next)}
        onLeave={() => void autosave.commit(key)}
      />
    {/snippet}
    <SettingField
      name={key}
      {node}
      {control}
      {form}
      keyState={session.stateOf(key)}
      {autosave}
      reverted={revert.isReverted(key)}
      custom={windowField}
      controlWidth="24rem"
      onEdit={() => revert.forget(key)}
    />
  {/if}
{/snippet}

<SettingsRestartNotice
  keys={session.restartKeys}
  {snapshot}
  flow={restartFlow}
  {revert}
  saving={autosave.busy}
/>

<div class="ib-retention" role="group" aria-label={SETTINGS_COPY.formLabel}>
  <FormSection grouped heading={copy.retention.heading}>
    {#each rows as key (key)}
      {@render windowRow(key)}
    {/each}
  </FormSection>

  {#if extraKeys.length > 0}
    <FormSection
      grouped
      heading={copy.otherRetention.heading}
      description={copy.otherRetention.description}
    >
      {#each extraKeys as key (key)}
        {#if isRetentionWindowNode(schema[key])}
          {@render windowRow(key)}
        {:else}
          {@const node = schema[key]}
          {@const control = session.controls.get(key)}
          {#if node !== undefined && control !== undefined}
            <SettingField
              name={key}
              {node}
              {control}
              {form}
              keyState={session.stateOf(key)}
              {autosave}
              reverted={revert.isReverted(key)}
              onEdit={() => revert.forget(key)}
            />
          {/if}
        {/if}
      {/each}
    </FormSection>
  {/if}

  <FormSection grouped heading={copy.storage.heading}>
    <StorageUsageRow />
  </FormSection>

  <FormSection grouped heading={copy.cleanUp.heading}>
    <CleanUpRow />
  </FormSection>
</div>

<style>
  .ib-retention {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    max-inline-size: 46rem;
    min-inline-size: 0;
  }
</style>
