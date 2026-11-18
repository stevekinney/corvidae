<script lang="ts">
  /**
   * The header of a hook that is saved (design rows 84l, 84m, 85x and sweep W42): the hook's name
   * for the page heading (its sentence when it has no name), the real On switch with the word "On"
   * beside it and a "More actions" menu holding Delete hook at the right, the hook as a sentence under
   * the heading, and its standing as one status line under it. A hook's standing (`hook-standing.ts`)
   * is one word in a fixed order, the same word its list row shows: Off, then Unavailable (its plugin
   * is disabled or no longer offers its action), then Needs setup, then its latest delivery, which
   * also says when it happened, what the receiver answered, and a "Jump to log" link to the delivery
   * log. A word that is not a delivery's is followed by its sentence and the one action it ends in
   * (an Add the key button, or a link to open the plugin in Settings). The switch saves the moment
   * it changes (`onToggle`); the page says so in a toast with Undo. At phone width the same header
   * narrows, and the status stays one line under it.
   *
   * A default hook (COR-2181, rows R10-04, R10-05 and R10-24) has no menu: its switch and a secondary
   * small "Duplicate" button sit on one row, there is no Delete, and a hook its plugin withdrew has
   * its switch held.
   */
  import {
    Button,
    Dropdown,
    Link,
    PageHeader,
    StatusDot,
    Toggle,
    Tooltip,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { Copy, Ellipsis, Trash2 } from '@lucide/svelte';

  import type { Hook } from '../../lib/bureau-hooks.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import type { LatestDelivery } from './hook-editor-presentation.ts';
  import type { HookStanding } from './hook-standing.ts';

  interface Props {
    /** The hook as the Bureau holds it. */
    hook: Hook;
    /** The page heading: the hook's name, or its sentence. */
    title: string;
    /** The hook as a sentence, under the heading. */
    sentence: string;
    /** What the newest delivery came to, or `undefined` while the deliveries are read or cannot be. */
    latest: LatestDelivery | undefined;
    /** Where the hook stands: the word of its one status, and the sentence after it. */
    standing: HookStanding;
    /** The title of the plugin that declared a default hook, for the reason its held switch gives. */
    declaringTitle?: string | undefined;
    /** Whether the switch is being saved. */
    togglePending: boolean;
    /** Whether a copy is being made. */
    duplicating?: boolean;
    /** Turns the hook on or off; the switch shows the saved value until the hook is read again. */
    onToggle: (next: boolean) => void;
    /** Opens the confirmation that deletes the hook. */
    onDelete: () => void;
    /** Makes an off copy the owner can change; only a default hook has it. */
    onDuplicate?: () => void;
    /** Opens the dialog that saves a secret the plugin lacks. */
    onAddKey?: (plugin: string, key: string) => void;
    /** Moves to the delivery log. */
    onJumpToLog: (event: MouseEvent) => void;
  }

  let {
    hook,
    title,
    sentence,
    latest,
    standing,
    declaringTitle,
    togglePending,
    duplicating = false,
    onToggle,
    onDelete,
    onDuplicate,
    onAddKey,
    onJumpToLog,
  }: Props = $props();

  const copy = HOOKS_COPY.editor.header;
  const isDefault = $derived(hook.declaredBy !== null);
  const withdrawn = $derived(hook.declaredBy?.withdrawn === true);
  /** The word's own line is the latest delivery's only when no other state decided the word. */
  const deliveryLine = $derived(standing.state === 'delivery');
  /** Settings › Plugins, which opens the plugin its address selects. */
  const pluginSettings = routerSelectionLocationFor('/settings/plugins');

  function openSettings(event: MouseEvent, plugin: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(pluginSettings.pathTo('plugin', plugin));
  }
</script>

{#snippet theSwitch()}
  <Toggle
    {...{ 'data-changes': true }}
    id="ib-hook-on"
    label={hook.enabled ? copy.on : copy.off}
    nameDetail={title}
    mutating
    checked={hook.enabled}
    disabled={togglePending || withdrawn}
    onValueChangeRequest={(next) => {
      onToggle(next);
      // The switch follows the saved hook once it has been read again, not the press. Cinder
      // takes the returned boolean as the value to show, so hand back the saved one.
      return hook.enabled;
    }}
  />
{/snippet}

<div class="ib-hook-identity" data-testid="hook-header" data-hook-state={standing.state}>
  <PageHeader
    {title}
    description={sentence}
    headingLevel={1}
    statusPlacement="below"
    {...deliveryLine && latest === undefined ? {} : { status: statusLine }}
  >
    {#snippet actions()}
      <div class="ib-hook-identity__actions">
        {#if withdrawn && hook.declaredBy !== null}
          <!-- As on the list row: a hook its plugin withdrew stays off, and the tooltip says why. -->
          <Tooltip
            text={HOOKS_COPY.standing.withdrawnSwitch(declaringTitle ?? hook.declaredBy.plugin)}
          >
            {@render theSwitch()}
          </Tooltip>
        {:else}
          {@render theSwitch()}
        {/if}
        {#if isDefault}
          <Button
            {...{ 'data-changes': true }}
            variant="secondary"
            size="sm"
            loading={duplicating}
            onclick={() => onDuplicate?.()}
          >
            {#snippet leadingIcon()}<Copy aria-hidden="true" />{/snippet}
            {HOOKS_COPY.defaultHook.duplicate}
          </Button>
        {:else}
          <Dropdown id="ib-hook-actions" placement="bottom-end">
            <Dropdown.Trigger caretVisible={false}>
              <Ellipsis aria-hidden="true" size={16} />
              <VisuallyHidden>{copy.menuLabel}</VisuallyHidden>
            </Dropdown.Trigger>
            <Dropdown.Menu>
              <Dropdown.Item data-changes variant="danger" onclick={onDelete}>
                <Trash2 aria-hidden="true" size={14} />
                {HOOKS_COPY.editor.check.delete}
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        {/if}
      </div>
    {/snippet}
  </PageHeader>
</div>

{#snippet statusLine()}
  <p class="ib-hook-identity__latest" data-testid="hook-latest-delivery">
    {#if deliveryLine && latest !== undefined}
      <span class="ib-hook-identity__latest-label">
        <VisuallyHidden>{copy.latestLabel}</VisuallyHidden>
        {#if latest.word !== undefined}
          <StatusDot word={latest.word} size="sm" data-status-word={latest.word} />
        {:else}
          <StatusDot status="pending" label={copy.nothingSent} size="sm" />
        {/if}
      </span>
      {#if latest.when !== undefined}
        <span class="ib-hook-identity__when" data-testid="hook-latest-when"
          >{latest.answer === undefined ? latest.when : `${latest.when}, ${latest.answer}`}</span
        >
      {/if}
      <Link href="#ib-hook-log" onclick={onJumpToLog}>{copy.jumpToLog}</Link>
    {:else if standing.word !== undefined}
      <span class="ib-hook-identity__latest-label">
        <StatusDot word={standing.word} size="sm" data-status-word={standing.word} />
      </span>
      {#if standing.sentence !== undefined}
        <span class="ib-hook-identity__when" data-testid="hook-standing-sentence"
          >{standing.sentence}</span
        >
      {/if}
      {#if standing.action?.kind === 'secret'}
        <!-- The sentence's one action reads as the link beside it does, though it opens a dialog. -->
        <Button
          variant="link"
          onclick={() => {
            if (standing.action?.kind === 'secret') {
              onAddKey?.(standing.action.plugin, standing.action.key);
            }
          }}>{standing.action.label}</Button
        >
      {:else if standing.action?.kind === 'settings'}
        {@const plugin = standing.action.plugin}
        <Link
          underline="always"
          href={router.href(pluginSettings.pathTo('plugin', plugin))}
          onclick={(event) => openSettings(event, plugin)}>{standing.action.label}</Link
        >
      {/if}
    {/if}
  </p>
{/snippet}

<style>
  .ib-hook-identity {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-hook-identity__actions {
    display: flex;
    align-items: center;
    /* Row R10-05: the switch and Duplicate sit 8px apart. */
    gap: var(--cinder-space-2);
  }

  .ib-hook-identity__latest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    margin: 0;
    min-width: 0;
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-identity__latest-label {
    display: inline-flex;
    align-items: center;
  }

  .ib-hook-identity__when {
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }
</style>
