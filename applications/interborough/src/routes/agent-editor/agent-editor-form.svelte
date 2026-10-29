<script lang="ts">
  /**
   * The fields of the agent editor, in four titled sections: Identity (name, identifier,
   * description), Model, Instructions, and Tools. A footer holds what acts on the agent as a whole:
   * the A2A switch, a delete for an agent that exists, and always cancel and save.
   * `skillDescriptors` has no field here; the state carries it through a save unchanged
   * (`agent-editor-state.svelte.ts`).
   *
   * The form owns no requests. The page that renders it sends a save and a delete, and says whether one is in flight. The page does not render the form for a catalog
   * with no model (`agent-editor-no-provider.svelte`), so every choice here has something to pick.
   */
  import { Button, FormSection, Input, Select, Textarea, Toggle } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorToolRow from './agent-editor-tool-row.svelte';

  interface Props {
    editor: AgentEditorState;
    /** A save or a delete is in flight. */
    busy: boolean;
    onSave: () => void;
    onCancel: () => void;
    /** Asks to delete the agent. Only an agent that exists has the control. */
    onDelete: () => void;
  }

  let { editor, busy, onSave, onCancel, onDelete }: Props = $props();

  const copy = AGENT_EDITOR_COPY;

  const modelOptionList = $derived([
    ...(editor.model === '' ? [{ value: '', label: copy.modelPlaceholder, disabled: true }] : []),
    ...editor.modelChoices,
  ]);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (editor.canSave && !busy) onSave();
  }
</script>

<form class="weft-agent-form" aria-label={copy.formLabel} onsubmit={submit}>
  <FormSection heading={copy.sections.identity} columns={2}>
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

    <div class="weft-agent-form__wide">
      <Input
        id="agent-description"
        label={copy.descriptionLabel}
        description={copy.descriptionDescription}
        bind:value={editor.description}
      />
    </div>
  </FormSection>

  <!-- The section's title names each control below, so the control's own label is not shown twice. -->
  <FormSection heading={copy.sections.model} columns={1}>
    <Select
      id="agent-model"
      label={copy.modelLabel}
      labelVisible={false}
      description={copy.modelDescription}
      options={modelOptionList}
      value={editor.model}
      onchange={(event) => (editor.model = event.currentTarget.value)}
    />
  </FormSection>

  <FormSection heading={copy.sections.instructions} columns={1}>
    <Textarea
      id="agent-instructions"
      aria-label={copy.instructionsLabel}
      description={copy.instructionsDescription}
      rows={8}
      bind:value={editor.instructions}
    />
  </FormSection>

  <FormSection
    as="fieldset"
    heading={copy.sections.tools}
    description={copy.toolsDescription}
    columns={1}
  >
    {#if editor.toolChoices.length === 0}
      <p class="weft-agent-form__note">{copy.noTools}</p>
    {:else}
      <ul class="weft-agent-form__tools">
        {#each editor.toolChoices as tool (tool.name)}
          <AgentEditorToolRow
            {tool}
            checked={editor.hasTool(tool.name)}
            onChange={(next) => editor.setTool(tool.name, next)}
          />
        {/each}
      </ul>
    {/if}
  </FormSection>

  <div class="weft-agent-form__footer">
    <div class="weft-agent-form__a2a">
      <Toggle id="agent-a2a" label={copy.a2aLabel} bind:checked={editor.a2a} disabled={busy} />
      <p class="weft-agent-form__note">{copy.a2aDescription}</p>
    </div>

    <div class="weft-agent-form__actions">
      {#if editor.mode === 'edit'}
        <Button variant="danger" disabled={busy} onclick={onDelete}>{copy.deleteAction}</Button>
      {/if}
      <Button variant="ghost" onclick={onCancel}>{copy.cancelAction}</Button>
      <Button type="submit" variant="primary" disabled={!editor.canSave || busy}>
        {editor.mode === 'create' ? copy.createAction : copy.saveAction}
      </Button>
    </div>
  </div>
</form>

<style>
  .weft-agent-form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .weft-agent-form__wide {
    grid-column: 1 / -1;
  }

  /* One short line under each field, a step up from Cinder's default so it reads as help. */
  .weft-agent-form :global(.cinder-form-field__description) {
    font-size: var(--cinder-text-sm);
  }

  .weft-agent-form__tools {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-agent-form__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  /*
   * What acts on the agent as a whole: the A2A switch on the left, the actions on the right. It stays
   * at the foot of the outlet while the form scrolls under it, so Save is always in reach.
   */
  .weft-agent-form__footer {
    position: sticky;
    /* The outlet pads its own bottom edge; reach through it so nothing scrolls under the bar. */
    bottom: calc(-1 * var(--cinder-space-6));
    z-index: 1;
    margin-block-end: calc(-1 * var(--cinder-space-6));
    padding-block: var(--cinder-space-3);
    background: var(--cinder-surface-canvas);
    border-block-start: 1px solid var(--cinder-border);
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3) var(--cinder-space-4);
    align-items: center;
    justify-content: space-between;
  }

  .weft-agent-form__a2a {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    align-items: center;
  }

  .weft-agent-form__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    margin-inline-start: auto;
  }
</style>
