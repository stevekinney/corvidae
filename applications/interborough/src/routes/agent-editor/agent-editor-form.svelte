<script lang="ts">
  /**
   * The fields of the agent editor: name, identifier, description, model, tools, and instructions,
   * and, for an agent that exists, whether it is published. `skills` has no field here; the state
   * carries it through a save unchanged (`agent-editor-state.svelte.ts`).
   *
   * The form owns no requests. The page that renders it sends a save, a publication change, and a
   * delete, and says whether one is in flight.
   */
  import {
    Button,
    Callout,
    Checkbox,
    CheckboxGroup,
    Input,
    Select,
    Textarea,
    Toggle,
  } from '@lostgradient/cinder';
  import { TriangleAlert } from '@lucide/svelte';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';

  interface Props {
    editor: AgentEditorState;
    /** A save, a publication change, or a delete is in flight. */
    busy: boolean;
    onSave: () => void;
    onCancel: () => void;
    /** Publish (`true`) or withdraw (`false`). Only an agent that exists has the control. */
    onPublishedChange: (next: boolean) => void;
  }

  let { editor, busy, onSave, onCancel, onPublishedChange }: Props = $props();

  const copy = AGENT_EDITOR_COPY;

  const modelOptionList = $derived([
    ...(editor.model === ''
      ? [
          {
            value: '',
            label: editor.hasModels ? copy.modelPlaceholder : copy.noModels.option,
            disabled: true,
          },
        ]
      : []),
    ...editor.modelChoices,
  ]);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (editor.canSave && !busy) onSave();
  }
</script>

<form class="weft-agent-form" aria-label={copy.formLabel} onsubmit={submit}>
  <div class="weft-agent-form__pair">
    <Input
      id="agent-name"
      label={copy.nameLabel}
      description={copy.nameDescription}
      bind:value={editor.name}
    />

    <Input
      id="agent-identifier"
      label={copy.identifierLabel}
      description={editor.mode === 'create'
        ? copy.identifierCreateDescription
        : copy.identifierEditDescription}
      variant="code"
      readonly={editor.mode === 'edit'}
      value={editor.identifier}
      onValueChange={(next) => (editor.identifier = next)}
      error={editor.identifierError}
    />
  </div>

  <Input
    id="agent-description"
    label={copy.descriptionLabel}
    description={copy.descriptionDescription}
    bind:value={editor.description}
  />

  {#if !editor.hasModels}
    <Callout variant="warning" semantic="note" title={copy.noModels.title}>
      {#snippet icon()}<TriangleAlert size={16} aria-hidden="true" />{/snippet}
      {copy.noModels.description}
    </Callout>
  {/if}
  <Select
    id="agent-model"
    label={copy.modelLabel}
    description={copy.modelDescription}
    options={modelOptionList}
    value={editor.model}
    onchange={(event) => (editor.model = event.currentTarget.value)}
    disabled={!editor.hasModels}
  />

  <Textarea
    id="agent-instructions"
    label={copy.instructionsLabel}
    description={copy.instructionsDescription}
    rows={8}
    bind:value={editor.instructions}
  />

  <CheckboxGroup label={copy.toolsLabel} description={copy.toolsDescription}>
    {#each editor.toolChoices as tool (tool.name)}
      <Checkbox
        id={`agent-tool-${tool.name}`}
        label={tool.name}
        description={tool.description}
        checked={editor.hasTool(tool.name)}
        onValueChange={(next) => editor.setTool(tool.name, next)}
      />
    {:else}
      <p class="weft-agent-form__note">{copy.noTools}</p>
    {/each}
  </CheckboxGroup>

  {#if editor.mode === 'edit'}
    <div class="weft-agent-form__published">
      <Toggle
        id="agent-published"
        label={copy.publishedLabel}
        checked={editor.published}
        disabled={busy}
        onValueChangeRequest={(next) => {
          onPublishedChange(next);
          return editor.published;
        }}
      />
      <p class="weft-agent-form__note">{copy.publishedDescription}</p>
    </div>
  {/if}

  <div class="weft-agent-form__actions">
    <Button type="submit" variant="primary" disabled={!editor.canSave || busy}>
      {editor.mode === 'create' ? copy.createAction : copy.saveAction}
    </Button>
    <Button variant="ghost" onclick={onCancel}>{copy.cancelAction}</Button>
  </div>
</form>

<style>
  .weft-agent-form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  /* The name and the identifier it follows are one thought: side by side where there is room. */
  .weft-agent-form__pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: var(--cinder-space-4);
    align-items: start;
  }

  .weft-agent-form__published {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
  }

  .weft-agent-form__note {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-agent-form__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }
</style>
