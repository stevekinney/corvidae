<script lang="ts">
  /**
   * The fields of the agent editor, in five titled sections: Identity (name, identifier,
   * description), Model, Instructions, Tools, and Guardrails and limits. A footer holds what acts on
   * the agent as a whole: the A2A switch, a delete for an agent that exists, and cancel. Save is
   * the page header's, and submits this form by its id ({@link AGENT_EDITOR_FORM_ID}).
   * `skillDescriptors` has no field here; the state carries it through a save unchanged
   * (`agent-editor-state.svelte.ts`).
   *
   * The form owns no requests. The page that renders it sends a save and a delete, and says whether one is in flight. The page does not render the form for a catalog
   * with no model (`agent-editor-no-provider.svelte`), so every choice here has something to pick.
   */
  import {
    Button,
    EmptyState,
    FormSection,
    Input,
    Select,
    Textarea,
    Toggle,
  } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { AGENT_EDITOR_FORM_ID } from './agent-editor-form-id.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorToolRow from './agent-editor-tool-row.svelte';

  interface Props {
    editor: AgentEditorState;
    /** A save or a delete is in flight. */
    busy: boolean;
    /** Saves the form. The page header's Save button submits this form, and so does ⌘Enter. */
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

<form
  id={AGENT_EDITOR_FORM_ID}
  class="weft-agent-form"
  aria-label={copy.formLabel}
  onsubmit={submit}
>
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
      <EmptyState
        kind="first-use"
        size="compact"
        align="start"
        headingLevel={3}
        title={copy.noTools}
      />
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

  <FormSection heading={copy.sections.limits} description={copy.limits.description} columns={2}>
    <div class="weft-agent-form__wide">
      <Textarea
        id="agent-guardrails"
        label={copy.limits.guardrailsLabel}
        description={copy.limits.guardrailsDescription}
        rows={2}
        error={editor.limitErrors.guardrails ?? ''}
        bind:value={editor.guardrails}
      />
    </div>
    <Input
      id="agent-step-limit"
      label={copy.limits.stepLimitLabel}
      description={copy.limits.stepLimitDescription}
      inputmode="numeric"
      error={editor.limitErrors.stepLimit ?? ''}
      bind:value={editor.stepLimit}
    />
    <Input
      id="agent-spend-per-run"
      label={copy.limits.spendPerRunLabel}
      description={copy.limits.spendPerRunDescription}
      inputmode="decimal"
      error={editor.limitErrors.spendPerRun ?? ''}
      bind:value={editor.spendPerRun}
    />
    <Input
      id="agent-spend-per-chat"
      label={copy.limits.spendPerChatLabel}
      description={copy.limits.spendPerChatDescription}
      inputmode="decimal"
      error={editor.limitErrors.spendPerChat ?? ''}
      bind:value={editor.spendPerChat}
    />
    <Input
      id="agent-tool-calls"
      label={copy.limits.toolCallsLabel}
      description={copy.limits.toolCallsDescription}
      inputmode="numeric"
      error={editor.limitErrors.toolCalls ?? ''}
      bind:value={editor.toolCalls}
    />
    <Input
      id="agent-tool-seconds"
      label={copy.limits.toolSecondsLabel}
      description={copy.limits.toolSecondsDescription}
      inputmode="decimal"
      error={editor.limitErrors.toolSeconds ?? ''}
      bind:value={editor.toolSeconds}
    />
  </FormSection>

  <div class="weft-agent-form__footer">
    <div class="weft-agent-form__a2a">
      <Toggle id="agent-a2a" label={copy.a2aLabel} bind:checked={editor.a2a} disabled={busy} />
      <p class="weft-agent-form__note">{copy.a2aDescription}</p>
    </div>

    <div class="weft-agent-form__actions">
      {#if editor.mode === 'edit'}
        <Button data-changes variant="danger" disabled={busy} onclick={onDelete}
          >{copy.deleteAction}</Button
        >
      {/if}
      <Button variant="ghost" onclick={onCancel}>{copy.cancelAction}</Button>
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
