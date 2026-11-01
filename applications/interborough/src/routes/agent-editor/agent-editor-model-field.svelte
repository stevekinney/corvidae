<script lang="ts">
  /**
   * The agent editor's model field: a Combobox of the models this installation offers, grouped by
   * provider (`agent-editor-models.ts`). A model the model policy forbids, a model turned off or
   * retired, and a provider with no API key are listed and disabled, each with its reason, and a
   * line under the field points to Settings › Models to connect a provider. The abilities of the
   * chosen model show under the field. The model the agent's file already names stays selected even
   * when it is not offered now, with a notice, and a save writes it back as it was.
   */
  import { Alert, Badge, Combobox, type ComboboxOption } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { providerDisplayName } from '../settings/models/format-model.ts';
  import { abilitiesOf, type ModelChoice } from './agent-editor-models.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';

  interface Props {
    editor: AgentEditorState;
  }

  let { editor }: Props = $props();

  const copy = AGENT_EDITOR_COPY.model;
  const SETTINGS_MODELS_PATH = '/settings/models';

  /** The prefix of the value that stands for a provider with no key, which is never a model. */
  const UNCONNECTED = 'unconnected:';

  function abilityLine(choice: ModelChoice): string {
    if (choice.row === undefined) return '';
    const abilities = abilitiesOf(choice.row);
    return [
      copy.context(abilities.context),
      ...abilities.has.map((ability) => copy.abilities[ability]),
    ].join(' · ');
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

  const chosen = $derived(editor.chosenModel);
  const abilities = $derived(chosen?.row === undefined ? undefined : abilitiesOf(chosen.row));
  /** Why the agent's own model cannot be chosen now, or `undefined` when it can. */
  const notice = $derived(
    chosen?.unavailable === undefined || editor.mode === 'create'
      ? undefined
      : copy.keptNotice(chosen.value, copy.reasons[chosen.unavailable]),
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
    placeholder={AGENT_EDITOR_COPY.modelPlaceholder}
    {options}
    value={editor.model}
    onValueChange={(next) => (editor.model = next)}
  />

  {#if notice !== undefined}
    <Alert variant="warning" data-testid="agent-model-notice">{notice}</Alert>
  {/if}

  {#if abilities !== undefined}
    <div
      class="weft-agent-model__abilities"
      role="group"
      aria-label={copy.abilitiesLabel}
      data-testid="agent-model-abilities"
    >
      <span>{copy.context(abilities.context)}</span>
      <span>{copy.maxOutput(abilities.maxOutput)}</span>
      {#each abilities.has as ability (ability)}
        <Badge variant="neutral" size="sm">{copy.abilities[ability]}</Badge>
      {:else}
        <span>{copy.textOnly}</span>
      {/each}
    </div>
  {/if}

  {#if unconnected.length > 0}
    <p class="weft-agent-model__hint" data-testid="agent-model-unconnected">
      {copy.unconnectedLead(unconnected)}
      <a href={router.href(SETTINGS_MODELS_PATH)} onclick={openSettings}>{copy.settingsLink}</a>.
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
    gap: var(--cinder-space-1) var(--cinder-space-3);
    align-items: center;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-model__hint {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
