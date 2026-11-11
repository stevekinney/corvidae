<script lang="ts">
  /**
   * The agent editor's model field: a Combobox of the models this installation offers, grouped by
   * provider (`agent-editor-models.ts`). A model the model policy forbids, a model turned off or
   * retired, and a provider with no API key are listed and disabled, each with its reason, and a
   * line under the field points to Settings › Models to connect a provider. The abilities of the
   * chosen model show under the field as one muted line (row 41h), and a new agent's form follows it
   * with "Not listed? Connect a provider in Settings › Models". The model the agent's file already
   * names stays selected even when it is not offered now, with a notice, and a save writes it back
   * as it was.
   *
   * The field is required: after a submit with no model it says so (`error`, row 42m). When the
   * catalog did not load (row 42v) it reads "No models to show", and a danger callout under it says
   * so with a Try again, while the rest of the form can still be filled in.
   */
  import { Alert, Button, Callout, Combobox, type ComboboxOption } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { providerDisplayName } from '../settings/models/format-model.ts';
  import {
    abilitiesOf,
    type ModelChoice,
    type ModelUnavailableReason,
  } from './agent-editor-models.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';

  interface Props {
    editor: AgentEditorState;
    /** Why the field stops a save, shown at it after a submit; `''` when nothing does. */
    error?: string;
    /** The catalog did not load, so the field has no model to offer (row 42v). */
    loadFailed?: boolean;
    /** The catalog is being read again after Try again. */
    retrying?: boolean;
    /** Reads the catalog again; the callout's Try again calls it. */
    onRetry?: (() => void) | undefined;
  }

  let { editor, error = '', loadFailed = false, retrying = false, onRetry }: Props = $props();

  const copy = AGENT_EDITOR_COPY.model;
  const newCopy = AGENT_EDITOR_COPY.newAgent;
  const SETTINGS_MODELS_PATH = '/settings/models';

  /** The prefix of the value that stands for a provider with no key, which is never a model. */
  const UNCONNECTED = 'unconnected:';

  function abilityLine(choice: ModelChoice): string {
    if (choice.row === undefined) return '';
    const abilities = abilitiesOf(choice.row);
    return [
      copy.context(abilities.context),
      ...abilities.has.map((ability) => copy.abilities[ability]),
    ].join(', ');
  }

  function optionOf(choice: ModelChoice, group: string): ComboboxOption {
    const description =
      choice.unavailable === undefined ? abilityLine(choice) : copy.reasons[choice.unavailable];
    return {
      value: choice.value,
      label: choice.value,
      group,
      ...(description === '' ? {} : { description }),
      ...(choice.unavailable === undefined ? {} : { disabled: true }),
    };
  }

  /**
   * Cinder filters on the text in the input, which holds the chosen model's name, so the default
   * would list only that model on focus. While the text is the chosen model's own name, nothing has
   * been typed to narrow by, so every option shows; once the text changes it narrows as Cinder does.
   */
  function filterOption(option: ComboboxOption, query: string): boolean {
    const text = query.trim().toLowerCase();
    if (text === '' || query === editor.model) return true;
    return (
      option.label.toLowerCase().includes(text) ||
      (option.description?.toLowerCase().includes(text) ?? false)
    );
  }

  const options = $derived(
    editor.modelGroups.flatMap((group): ComboboxOption[] => {
      const name = providerDisplayName(group.provider);
      const listed = group.choices.map((choice) => optionOf(choice, name));
      // A provider with no key has no model to list: one disabled option says so, and where to fix it.
      return group.connected
        ? listed
        : [
            {
              value: `${UNCONNECTED}${group.provider}`,
              label: copy.notConnected(name),
              description: copy.notConnectedDescription,
              group: name,
              disabled: true,
            },
            ...listed,
          ];
    }),
  );

  const unconnected = $derived(
    editor.modelGroups
      .filter((group) => !group.connected)
      .map((group) => providerDisplayName(group.provider)),
  );

  /** What a save does with the agent's own model decides which notice the field shows. */
  function noticeFor(reason: ModelUnavailableReason): (model: string, reason: string) => string {
    switch (reason) {
      case 'provider-denied':
      case 'model-denied':
        return copy.refusedNotice;
      case 'retired':
      case 'not-in-catalog':
        return copy.replacementNotice;
      case 'turned-off':
        return copy.keptNotice;
    }
  }

  const chosen = $derived(editor.chosenModel);
  const abilities = $derived(chosen?.row === undefined ? undefined : abilitiesOf(chosen.row));
  /** Why the agent's own model cannot be chosen now, or `undefined` when it can. */
  const notice = $derived(
    chosen?.unavailable === undefined || editor.mode === 'create'
      ? undefined
      : noticeFor(chosen.unavailable)(chosen.value, copy.reasons[chosen.unavailable]),
  );

  /** Follows the link in the app's router, unless the click asks for a new tab. */
  function openSettings(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(SETTINGS_MODELS_PATH);
  }
</script>

<div class="weft-agent-model">
  <Combobox
    id="agent-model"
    aria-label={AGENT_EDITOR_COPY.modelLabel}
    description={AGENT_EDITOR_COPY.modelDescription}
    placeholder={loadFailed ? newCopy.modelsFailed.placeholder : AGENT_EDITOR_COPY.modelPlaceholder}
    required
    {error}
    {options}
    filter={filterOption}
    value={editor.model}
    onValueChange={(next) => (editor.model = next)}
  />

  {#if loadFailed}
    <!-- A failure is red (row 42v), and the rest of the form stays usable. -->
    <Callout
      variant="danger"
      semantic="note"
      title={newCopy.modelsFailed.title}
      data-testid="agent-models-failed"
    >
      <p class="weft-agent-model__failed">{newCopy.modelsFailed.description}</p>
      {#snippet action()}
        <Button type="button" variant="secondary" size="sm" loading={retrying} onclick={onRetry}
          >{newCopy.modelsFailed.retry}</Button
        >
      {/snippet}
    </Callout>
  {/if}

  {#if notice !== undefined}
    <Alert variant="warning" data-testid="agent-model-notice">{notice}</Alert>
  {/if}

  {#if abilities !== undefined}
    <!-- One muted line: what the model can do, then its window, each word plain (row 41h). -->
    <div
      class="weft-agent-model__abilities"
      role="group"
      aria-label={copy.abilitiesLabel}
      data-testid="agent-model-abilities"
    >
      {#each abilities.has as ability (ability)}
        <span>{copy.abilities[ability]}</span>
      {:else}
        <span>{copy.textOnly}</span>
      {/each}
      <span>{copy.context(abilities.context)}</span>
      <span>{copy.maxOutput(abilities.maxOutput)}</span>
    </div>
  {/if}

  {#if unconnected.length > 0}
    <p class="weft-agent-model__hint" data-testid="agent-model-unconnected">
      {copy.unconnectedLead(unconnected)}
      <a href={router.href(SETTINGS_MODELS_PATH)} onclick={openSettings}>{copy.settingsLink}</a>.
    </p>
  {:else if editor.mode === 'create'}
    <p class="weft-agent-model__hint" data-testid="agent-model-not-listed">
      {newCopy.notListed}
      <a href={router.href(SETTINGS_MODELS_PATH)} onclick={openSettings}>{copy.settingsLink}</a>
    </p>
  {/if}
</div>

<style>
  .weft-agent-model {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .weft-agent-model__abilities {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) 0;
    align-items: baseline;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  /* A comma between the words, drawn so each word stays its own text; never a middle dot. */
  .weft-agent-model__abilities > span:not(:last-child)::after {
    content: ',\00a0';
  }

  .weft-agent-model__failed {
    margin: 0;
  }

  .weft-agent-model__hint {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
