<script lang="ts">
  /**
   * The fields of the agent editor, in titled sections: Identity (name, identifier, description),
   * Model (the model and its default effort), Instructions, Tools, and, for an agent that exists,
   * Guardrails and limits. A new agent's form has no Guardrails and limits section: the Access tab
   * is where they are set once the agent is saved (S31). The column is capped at Cinder's reading
   * width, so the fields do not stretch across a wide window (S35).
   *
   * A sticky bar at the foot holds what acts on the agent as a whole: the A2A switch, the save's
   * status ("Saving…" while it is in flight, rows 43j and 14w; "Not saved yet" on a new agent
   * otherwise, rows 43w and 44b), a delete for an agent that exists,
   * and Cancel then Save (row 42n). Save stays enabled whatever the form holds (W35): a submit marks
   * the fields that stop it, and the page focuses the first. While a save is in flight Save is in
   * Cinder's loading state, which ignores a second press, and Cancel stays available. ⌘Enter submits
   * the form from the page. `card` has no field here; the state carries it through a save unchanged
   * (`agent-editor-state.svelte.ts`).
   *
   * A new agent's identifier is set from its name and shown once, small and monospaced, with a
   * Change that turns it into a field with a Reset back to the name's (rows 41e, 42x). Its Tools
   * section is a table with one Asks select per tool (`agent-editor-tools.svelte`). Tools are chosen
   * from a drawer (`agent-editor-tool-picker.svelte`).
   *
   * The form owns no requests. The page that renders it sends a save and a delete, and says whether
   * one is in flight. The page does not render the form for a catalog with no model
   * (`agent-editor-no-provider.svelte`). The model is chosen in `agent-editor-model-field.svelte`,
   * and its default effort in `agent-editor-effort-field.svelte`.
   */
  import { Button, EmptyState, FormSection, Input, Textarea, Toggle } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { AGENT_EDITOR_FORM_ID } from './agent-editor-form-id.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorEffortField from './agent-editor-effort-field.svelte';
  import AgentEditorModelField from './agent-editor-model-field.svelte';
  import AgentEditorToolPicker from './agent-editor-tool-picker.svelte';
  import AgentEditorTools from './agent-editor-tools.svelte';

  interface Props {
    editor: AgentEditorState;
    /** A save or a delete is in flight. */
    busy: boolean;
    /** A save is in flight and has not timed out: Save shows its loading state. */
    saving?: boolean;
    /** Submits the form. Save and ⌘Enter both call it; the page decides whether to send. */
    onSave: () => void;
    onCancel: () => void;
    /** Asks to delete the agent. Only an agent that exists has the control. */
    onDelete: () => void;
    /** The catalog is being read again after the model field's Try again (row 42v). */
    retryingModels?: boolean;
    /** Reads the catalog again, from the model field's Try again (row 42v). */
    onRetryModels?: (() => void) | undefined;
  }

  let {
    editor,
    busy,
    saving = false,
    onSave,
    onCancel,
    onDelete,
    retryingModels = false,
    onRetryModels,
  }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const newCopy = AGENT_EDITOR_COPY.newAgent;
  let pickerOpen = $state(false);

  const creating = $derived(editor.mode === 'create');
  const errors = $derived(editor.shownErrors);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!saving) onSave();
  }
</script>

<!-- `novalidate`: the form says what is missing at each field itself, so the browser's own bubble never stops a submit. -->
<form
  id={AGENT_EDITOR_FORM_ID}
  class="weft-agent-form"
  aria-label={copy.formLabel}
  novalidate
  onsubmit={submit}
>
  <FormSection heading={copy.sections.identity} columns={creating ? 1 : 2}>
    <Input
      id="agent-name"
      label={copy.nameLabel}
      description={copy.nameDescription}
      required={creating}
      error={errors.name}
      bind:value={editor.name}
    />

    {#if !creating}
      <Input
        id="agent-identifier"
        label={copy.identifierLabel}
        description={copy.identifierEditDescription}
        variant="code"
        readonly
        value={editor.identifier}
      />
    {:else if editor.identifierFollowsName}
      <p class="weft-agent-form__identifier" data-testid="agent-identifier">
        {#if editor.identifier !== ''}
          <code class="weft-agent-form__identifier-value">{editor.identifier}</code
          >{newCopy.setFromName}
        {/if}
        <Button
          type="button"
          variant="ghost-accent"
          size="sm"
          aria-label={newCopy.changeIdentifierLabel}
          onclick={() => editor.changeIdentifier()}>{newCopy.changeIdentifier}</Button
        >
      </p>
    {:else}
      <Input
        id="agent-identifier"
        label={copy.identifierLabel}
        description={newCopy.identifierHint}
        variant="code"
        required
        value={editor.identifier}
        onValueChange={(next) => (editor.identifier = next)}
        error={errors.identifier}
      >
        {#snippet descriptionAction()}
          {#if editor.suggestedIdentifier !== '' && editor.suggestedIdentifier !== editor.identifier}
            <Button
              type="button"
              variant="ghost-accent"
              size="sm"
              data-testid="agent-identifier-reset"
              onclick={() => editor.resetIdentifier()}
              >{newCopy.resetIdentifier(editor.suggestedIdentifier)}</Button
            >
          {/if}
        {/snippet}
      </Input>
    {/if}

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
    <AgentEditorModelField
      {editor}
      error={errors.model}
      loadFailed={editor.catalogMissing}
      retrying={retryingModels}
      onRetry={onRetryModels}
    />
    <AgentEditorEffortField {editor} />
  </FormSection>

  <!-- A Markdown body: monospaced, with its word count beside the title (row 41i). -->
  <FormSection
    heading={copy.sections.instructions}
    meta={`${newCopy.instructionsFormat}, ${newCopy.wordCount(editor.instructionWords)}`}
    columns={1}
  >
    <Textarea
      id="agent-instructions"
      aria-label={copy.instructionsLabel}
      description={copy.instructionsDescription}
      variant="code"
      rows={8}
      bind:value={editor.instructions}
    />
  </FormSection>

  <FormSection
    as="fieldset"
    heading={copy.sections.tools}
    {...creating
      ? editor.catalogMissing
        ? {}
        : { meta: newCopy.toolCount(editor.chosenTools.length, editor.toolChoices.length) }
      : { description: copy.toolsDescription }}
    columns={1}
  >
    {#if editor.catalogMissing}
      <p class="weft-agent-form__note" data-testid="agent-tools-waiting">
        {newCopy.toolsWaitOnModels}
      </p>
    {:else if editor.toolChoices.length === 0}
      <EmptyState
        kind="first-use"
        size="compact"
        align="start"
        headingLevel={3}
        title={copy.noTools}
      />
    {:else}
      <AgentEditorTools {editor} onAdd={() => (pickerOpen = true)} />
    {/if}
  </FormSection>

  {#if !creating}
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
  {/if}

  <div class="weft-agent-form__footer">
    <div class="weft-agent-form__a2a">
      <Toggle id="agent-a2a" label={copy.a2aLabel} bind:checked={editor.a2a} disabled={busy} />
      <p class="weft-agent-form__note">{copy.a2aDescription}</p>
    </div>

    <div class="weft-agent-form__actions">
      <p class="weft-agent-form__status" role="status" data-testid="agent-save-status">
        {saving ? newCopy.saving : creating ? copy.try.notSavedYet : ''}
      </p>
      {#if editor.mode === 'edit'}
        <Button data-changes variant="danger" disabled={busy} onclick={onDelete}
          >{copy.deleteAction}</Button
        >
      {/if}
      <Button type="button" variant="ghost" onclick={onCancel}>{copy.cancelAction}</Button>
      <Button data-changes type="submit" variant="primary" loading={saving}>
        {creating ? copy.createAction : copy.saveAction}
      </Button>
    </div>
  </div>
</form>

<!-- A dialog inside the form would put its buttons in the form, so the picker sits beside it. -->
{#if editor.toolChoices.length > 0}
  <AgentEditorToolPicker {editor} bind:open={pickerOpen} />
{/if}

<style>
  /* The fields keep to Cinder's reading width inside the full-width view (S35). */
  .weft-agent-form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    max-inline-size: 48rem;
  }

  .weft-agent-form__wide {
    grid-column: 1 / -1;
  }

  .weft-agent-form__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  /* The identifier the name sets, once, small and monospaced, with Change beside it (row 41e). */
  .weft-agent-form__identifier {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--cinder-space-2);
    align-items: baseline;
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-form__identifier-value {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-secondary);
  }

  /*
   * What acts on the agent as a whole: the A2A switch on the left, the status and actions on the
   * right. It stays at the foot of the outlet while the form scrolls under it, so Save is always in
   * reach.
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

  .weft-agent-form__status {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
