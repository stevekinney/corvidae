<script lang="ts">
  /**
   * The Event field of the hook editor: a searchable picker over every event a hook can listen to,
   * grouped by area, each named in plain words with its raw kind beside it. It matches what a person
   * types against the words, the raw kind, the area, and what the event means. An event the chosen
   * action cannot listen to is listed but cannot be chosen, with the reason beside it. The events
   * chosen are listed under the field, each with a button that removes it.
   *
   * A hook that is saved keeps its events: the field then reads them as plain text (Cinder's
   * read-only Select, with the raw kind small and monospaced beside it and a lock) and says they
   * cannot be changed, so a different event is a new hook.
   */
  import { Button, Combobox, Select } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';

  import type { HookActionType, HookEventKind } from '../../lib/bureau-hooks.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { EVENTS_MAXIMUM } from './hook-form-state.svelte.ts';
  import { eventChoices, eventMatches, eventOptionLabel } from './hook-presentation.ts';

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
  }

  let { kinds, action, events = $bindable(), locked = false, error }: Props = $props();

  const copy = HOOKS_COPY.editor.event;

  const choices = $derived(
    eventChoices(kinds, action).filter((choice) => !events.includes(choice.value)),
  );
  /** The events of a saved hook as one value and one line of words, for the read-only field. */
  const lockedValue = $derived(events.join(','));
  const lockedLabel = $derived(events.map(eventOptionLabel).join(', '));
  const meanings = $derived(new Map(kinds.map((kind) => [kind.kind, kind.description])));
  /** The picker holds no value: choosing an event adds it to the list and clears the field. */
  let picked = $state('');

  function add(kind: string): void {
    if (kind === '' || events.includes(kind) || events.length >= EVENTS_MAXIMUM) return;
    events = [...events, kind];
    picked = '';
  }
</script>

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
      <span class="ib-hook-events__lock">
        {#each events as kind (kind)}
          <code class="ib-hook-events__kind" data-event={kind}>{kind}</code>
        {/each}
        <Lock aria-hidden="true" size={14} />
      </span>
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
            <span class="ib-hook-events__name">{eventOptionLabel(kind)}</span>
            <code class="ib-hook-events__kind">{kind}</code>
            <Button
              variant="ghost"
              size="sm"
              aria-label={copy.remove(eventOptionLabel(kind))}
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
    color: var(--cinder-text-muted);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }
</style>
