<script lang="ts">
  /**
   * The Event field of the hook editor: a searchable picker over every event a hook can listen to,
   * grouped by area, each named in plain words; the raw kind is shown, small and monospaced, only
   * beside two events that would otherwise read the same (R10-23). It matches what a person types
   * against the words, the raw kind, the area, and what the event means. An event the chosen action
   * cannot listen to is listed but cannot be chosen, with the reason beside it. The events chosen are
   * listed under the field, each with a button that removes it.
   *
   * A hook that is saved keeps its events: the field then reads them as plain text (Cinder's
   * read-only Select, with a lock) and says they cannot be changed, so a different event is a new
   * hook.
   *
   * A kind a plugin declares (COR-2226) is offered in its plugin's group, under the plugin's title,
   * by its own words with its raw kind beside them (rows R1 and R2). Chosen, it reads with its
   * plugin's title after its words (row R3), and its raw kind carries, muted, the version the hook
   * is pinned to: the version the Bureau lists while the hook is new, and the pin once it is saved
   * (row R4). Without a plugin kind the field is what it always was (row R7).
   */
  import { Button, Combobox, Select } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';

  import type { HookActionType, HookEventKind } from '../../lib/bureau-hooks.ts';
  import { humanizeName } from '../settings/plugins/plugin-presentation.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { EVENTS_MAXIMUM } from './hook-form-state.svelte.ts';
  import {
    eventChoices,
    eventChosenLabel,
    eventKindOf,
    eventMatches,
    kindsReadingAlike,
    pluginEventOf,
  } from './hook-presentation.ts';

  interface Props {
    /** Every event kind the Bureau describes. */
    kinds: readonly HookEventKind[];
    /** The action the hook performs, which decides the events that cannot be chosen. */
    action: HookActionType | 'plugin';
    /** The kinds chosen. */
    events: string[];
    /** Whether the hook is saved, so its events are shown and cannot be changed. */
    locked?: boolean;
    /** Why the field cannot be accepted, said beside it. */
    error?: string | undefined;
    /** A plugin's title by its name; its name in words when the page has none. */
    titleOf?: (plugin: string) => string;
  }

  let {
    kinds,
    action,
    events = $bindable(),
    locked = false,
    error,
    titleOf = humanizeName,
  }: Props = $props();

  const copy = HOOKS_COPY.editor.event;

  /** The kinds chosen, without the pins of a saved hook's plugin kinds. */
  const chosenKinds = $derived(new Set(events.map(eventKindOf)));
  const choices = $derived(
    eventChoices(kinds, action, titleOf).filter((choice) => !chosenKinds.has(choice.value)),
  );
  const labelOf = (kind: string): string => eventChosenLabel(kind, titleOf);
  /** The events of a saved hook as one value and one line of words, for the read-only field. */
  const lockedValue = $derived(events.join(','));
  const lockedLabel = $derived(events.map(labelOf).join(', '));
  const meanings = $derived(new Map(kinds.map((kind) => [kind.kind, kind.description])));
  /** The events chosen whose words another chosen event shares: these show their raw kind. */
  const alike = $derived(kindsReadingAlike(events, labelOf));
  /** Whether an entry shows its raw kind: a plugin's kind always, another only where it reads alike. */
  const showsKind = (entry: string): boolean =>
    pluginEventOf(entry) !== undefined || alike.has(eventKindOf(entry));
  const lockedKinds = $derived(events.filter(showsKind));
  /** The version an entry is pinned to: its own pin once saved, the one the Bureau lists before. */
  function versionOf(entry: string): string | undefined {
    const plugin = pluginEventOf(entry);
    if (plugin === undefined) return undefined;
    return plugin.version ?? kinds.find((kind) => kind.kind === plugin.kind)?.version;
  }
  /** The picker holds no value: choosing an event adds it to the list and clears the field. */
  let picked = $state('');

  function add(kind: string): void {
    if (kind === '' || chosenKinds.has(kind) || events.length >= EVENTS_MAXIMUM) return;
    events = [...events, kind];
    picked = '';
  }
</script>

{#snippet rawKind(entry: string)}
  {@const version = versionOf(entry)}
  <code class="ib-hook-events__kind" data-event={entry}
    >{eventKindOf(entry)}{#if version !== undefined}<span class="ib-hook-events__version"
        >@{version}</span
      >{/if}</code
  >
{/snippet}

<div class="ib-hook-events" data-testid="hook-events">
  {#if locked}
    <div class="ib-hook-events__locked" data-testid="hook-event-locked">
      <Select
        id="ib-hook-event"
        label={copy.label}
        description={copy.fixed}
        required
        readonly
        options={[{ value: lockedValue, label: lockedLabel }]}
        value={lockedValue}
      />
      <!-- The kind shows only for a plugin's kind, with its pin, and where two events read alike;
           otherwise the read-only Select and its description already say the event is fixed, and a
           lone lock would belong to nothing. -->
      {#if lockedKinds.length > 0}
        <span class="ib-hook-events__lock">
          {#each lockedKinds as kind (kind)}
            {@render rawKind(kind)}
          {/each}
          <Lock aria-hidden="true" size={14} />
        </span>
      {/if}
    </div>
  {:else}
    <Combobox
      id="ib-hook-event"
      label={copy.label}
      description={copy.description}
      placeholder={copy.placeholder}
      required
      {...error === undefined ? {} : { error }}
      options={choices}
      filter={(option, query) => eventMatches(option, query, meanings)}
      bind:value={picked}
      onValueChange={add}
    />
    {#if events.length > 0}
      <h3 class="ib-hook-events__heading">{copy.chosenHeading}</h3>
      <ul class="ib-hook-events__list">
        {#each events as kind (kind)}
          <li class="ib-hook-events__item" data-event={kind}>
            <span class="ib-hook-events__name">{labelOf(kind)}</span>
            {#if showsKind(kind)}
              {@render rawKind(kind)}
            {/if}
            <Button
              variant="ghost"
              size="sm"
              aria-label={copy.remove(labelOf(kind))}
              onclick={() => (events = events.filter((chosen) => chosen !== kind))}
              >{copy.removeAction}</Button
            >
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .ib-hook-events {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-hook-events__locked {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-events__lock {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-2);
    color: var(--cinder-text-muted);
  }

  .ib-hook-events__heading {
    margin: var(--cinder-space-2) 0 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .ib-hook-events__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-hook-events__item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-events__name {
    overflow-wrap: anywhere;
  }

  .ib-hook-events__kind {
    min-width: 0;
    color: var(--cinder-text-muted);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  /* The pin reads quieter than the kind it pins (row R4). */
  .ib-hook-events__version {
    color: var(--cinder-text-subtle, var(--cinder-text-muted));
  }
</style>
