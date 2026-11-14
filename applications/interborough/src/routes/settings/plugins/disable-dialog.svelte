<script lang="ts">
  /**
   * The question before a plugin is turned off (board PageSettingsSections, "Disabling a plugin"):
   * a Cinder confirm dialog. Interborough restarts to unload the plugin, so it lists what depends on
   * it now, from the counts the host reports for each thing the plugin adds (`disableImpacts`), or
   * says that nothing does. The runs its agents have going come first, named, because the restart
   * fails them (COR-2235): they are read before the dialog opens (`plugin-runs.ts`), and the dialog
   * is destructive while it lists any. The list and the note are direct children of the dialog's
   * options, which Cinder draws as flat rows and a muted note, so the page adds no list styles.
   * Confirming writes the choice and restarts in one step through the shared restart flow; Cancel
   * changes nothing.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import type { PluginStanding } from '../../../lib/host-plugins.ts';
  import PendingWritesList from './pending-writes-list.svelte';
  import type { PluginWrite } from './plugin-drafts.svelte.ts';
  import { disableImpacts, NO_RUNS, type InFlightRuns } from './plugin-presentation.ts';

  interface Props {
    /** The plugin the question is about, or `null` while it is closed. */
    plugin: PluginStanding | null;
    /** The runs of the plugin's agents that are going, read as the question opened. */
    runs?: InFlightRuns;
    /** The other changes the restart writes with this one. */
    otherChanges: readonly PluginWrite[];
    onConfirm: (plugin: PluginStanding) => void;
    onCancel: () => void;
  }

  let { plugin, runs = NO_RUNS, otherChanges, onConfirm, onCancel }: Props = $props();

  const copy = PLUGINS_COPY.disable;
  // The plugin and its runs stay shown while the dialog leaves, after the page has let go of them.
  let last = $state<{ plugin: PluginStanding; runs: InFlightRuns } | null>(null);
  $effect(() => {
    if (plugin !== null) last = { plugin, runs };
  });
  const shown = $derived(plugin === null ? last : { plugin, runs });
  const impacts = $derived(shown === null ? [] : disableImpacts(shown.plugin, shown.runs));
  /**
   * Confirming fails work that cannot be got back, so it is destructive while a run is listed, and
   * while the read failed: that state is only reached by a plugin that adds agents, and says any
   * run going will fail.
   */
  const runsUnknown = $derived(shown !== null && shown.runs.kind === 'unknown');
  const failsRuns = $derived(
    runsUnknown || (shown !== null && shown.runs.kind === 'listed' && shown.runs.runs.length > 0),
  );
  const note = $derived(
    runsUnknown
      ? copy.reassuranceRunsUnknown
      : failsRuns
        ? copy.reassuranceWithRuns
        : copy.reassurance,
  );

  function confirm(): void {
    if (plugin !== null) onConfirm(plugin);
  }
</script>

{#if shown !== null}
  <ConfirmDialog
    open={plugin !== null}
    title={copy.title(shown.plugin.descriptor.title)}
    description={copy.intro}
    cancelLabel={copy.cancel}
    confirmLabel={copy.confirm}
    destructive={failsRuns}
    onConfirm={confirm}
    {onCancel}
  >
    {#snippet options()}
      {#if impacts.length === 0}
        <p data-testid="plugin-disable-nothing">
          <strong>{copy.nothingLead}</strong>{copy.nothing(shown.plugin.descriptor.title)}
        </p>
      {:else}
        <ul data-testid="plugin-disable-impacts">
          {#each impacts as impact (impact.key)}
            <li data-impact={impact.key}>
              <strong>{impact.count}</strong>
              {impact.sentence}
            </li>
          {/each}
        </ul>
      {/if}
      <PendingWritesList changes={otherChanges} />
      <p data-testid="plugin-disable-note">{note}</p>
    {/snippet}
  </ConfirmDialog>
{/if}
