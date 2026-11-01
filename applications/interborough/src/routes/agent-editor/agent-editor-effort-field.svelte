<script lang="ts">
  /**
   * The agent editor's default effort field: the reasoning effort a chat of the agent starts at,
   * chosen from the tiers the chosen model supports (`editor.effortChoices`, from the catalog's
   * `effort.portable`) or None. A model with no effort control offers None alone, and says so. When
   * a change of model clears an effort the new model cannot do, a notice says which. The Bureau
   * refuses an unsupported effort at a save (`effort-not-supported`); the field marks it beforehand.
   */
  import { Alert, Select } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY, EFFORT_LABELS } from '../../app/copy.ts';
  import { EFFORTS } from '../../lib/agent-definitions.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';

  interface Props {
    editor: AgentEditorState;
  }

  let { editor }: Props = $props();

  const copy = AGENT_EDITOR_COPY.effort;

  /** The model is in the catalog and has no effort control, so None is the only choice. */
  const unsupportedByModel = $derived(
    editor.chosenModel?.row !== undefined && editor.effortChoices.length === 0,
  );
  /** Nothing to choose: the model has no effort control and the file holds none to change. */
  const nothingToChoose = $derived(unsupportedByModel && editor.defaultEffort === '');

  /**
   * None, then the tiers the model supports. The effort the file holds stays listed when the model
   * does not support it, so the select shows what the file says and the error beside it says why
   * it cannot be saved.
   */
  const options = $derived([
    { value: '', label: copy.none },
    ...EFFORTS.filter(
      (effort) => effort === editor.defaultEffort || editor.effortChoices.includes(effort),
    ).map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
  ]);

  function choose(value: string): void {
    editor.defaultEffort = EFFORTS.find((effort) => effort === value) ?? '';
  }
</script>

<div class="weft-agent-effort">
  <Select
    id="agent-default-effort"
    label={copy.label}
    description={unsupportedByModel ? copy.notSupportedByModel : copy.description}
    {options}
    value={editor.defaultEffort}
    disabled={nothingToChoose}
    error={editor.effortError}
    onchange={(event) => choose(event.currentTarget.value)}
  />

  {#if editor.effortNotice !== ''}
    <Alert variant="warning" data-testid="agent-effort-notice">{editor.effortNotice}</Alert>
  {/if}
</div>

<style>
  .weft-agent-effort {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }
</style>
