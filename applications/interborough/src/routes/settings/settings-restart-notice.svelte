<script lang="ts">
  /**
   * The restart notice every section of Settings shares (board SettingsShell, "General", and the
   * "same restart banner" rows of each section): a sticky warning banner that counts the saved
   * changes waiting for a restart and offers Revert and Restart now, the question before a restart
   * and its progress, and the banner that says the host is back. Restart now is never one click: it
   * asks first, naming the effect on running work. Below 640px the buttons stack, each a full-width
   * 44px target, and the question opens as a bottom sheet (board ResponsiveAndDark, "Phone").
   *
   * The page owns the {@link HostRestartFlow} and the {@link SettingsRevert}, because it also
   * words each row from them (a reverted row, "In effect since"); this draws what they say. It
   * draws into the page grid's `banner` area (`settings-frame.svelte`).
   */
  import { Banner, Button } from '@lostgradient/cinder';
  import { RotateCw, TriangleAlert } from '@lucide/svelte';

  import { RESTART_COPY, SETTINGS_COPY } from '../../app/copy.ts';
  import type { HostRestartFlow } from '../../app/restart/host-restart-flow.svelte.ts';
  import RestartBackBanner from '../../app/restart/restart-back-banner.svelte';
  import RestartConfirmDialog from '../../app/restart/restart-confirm-dialog.svelte';
  import RestartDialog from '../../app/restart/restart-dialog.svelte';
  import type { SettingsSnapshot } from '../../lib/bureau-settings.ts';
  import { settingLabel } from './settings-controls.ts';
  import type { SettingsRevert } from './settings-revert.svelte.ts';

  interface Props {
    /** The settings that wait for a restart, in the order the page lists them. */
    keys: readonly string[];
    /** The settings the page holds now, which Revert puts the waiting keys back to the running value of. */
    snapshot: SettingsSnapshot;
    /** The restart: its phases, its refusal and its progress. */
    flow: HostRestartFlow<SettingsSnapshot>;
    /** Revert and its Undo. */
    revert: SettingsRevert;
    /** Whether a save is in flight, which holds Revert back so it does not race the save. */
    saving?: boolean;
  }

  let { keys, snapshot, flow, revert, saving = false }: Props = $props();

  let confirming = $state(false);
  const refusalWords = $derived(
    flow.refusal === undefined || flow.refusal === 'save-failed'
      ? ''
      : RESTART_COPY.refusal[flow.refusal],
  );
  const copy = SETTINGS_COPY.general.restartBanner;
</script>

{#if flow.phase === 'back' || flow.phase === 'unconfirmed' || keys.length > 0}
  <div class="weft-settings-restart" data-testid="settings-banner">
    {#if flow.phase === 'back'}
      <RestartBackBanner
        title={RESTART_COPY.back.title}
        text={RESTART_COPY.back.applied(flow.intent.changes)}
        onDismiss={() => flow.close()}
      />
    {:else if flow.phase === 'unconfirmed'}
      <Banner
        variant="warning"
        dismissible
        onDismiss={() => flow.close()}
        title={RESTART_COPY.unconfirmed.title}
        titleLayout="stacked"
        data-testid="settings-restart-unconfirmed"
      >
        {RESTART_COPY.unconfirmed.description}
      </Banner>
    {:else if keys.length > 0}
      <Banner
        variant="warning"
        sticky
        stackActions
        dismissible={false}
        title={copy.title(keys.length)}
        titleLayout="stacked"
        data-testid="settings-restart-summary"
      >
        {#snippet icon()}<TriangleAlert size={16} aria-hidden="true" />{/snippet}
        {copy.detail(keys.map(settingLabel))}
        {#if refusalWords !== ''}
          <span data-testid="settings-restart-refused">{refusalWords}</span>
        {/if}
        {#snippet actions()}
          <Button
            variant="secondary"
            size="sm"
            disabled={flow.running || revert.busy || saving}
            data-testid="settings-revert"
            onclick={() => void revert.revert(keys, snapshot)}
          >
            {copy.revert(keys.length)}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={flow.running || revert.busy}
            onclick={() => (confirming = true)}
          >
            {#snippet leadingIcon()}<RotateCw size={14} aria-hidden="true" />{/snippet}
            {RESTART_COPY.confirm.confirm}
          </Button>
        {/snippet}
      </Banner>
    {/if}
  </div>
{/if}

<RestartConfirmDialog
  bind:open={confirming}
  changes={keys.length}
  onConfirm={() => void flow.restart({ changes: keys.map(settingLabel) })}
/>
<RestartDialog {flow} />

<style>
  .weft-settings-restart {
    grid-area: banner;
    position: sticky;
    inset-block-start: 0;
    z-index: 1;
    min-inline-size: 0;
    margin-block-end: var(--cinder-space-4);
  }
</style>
