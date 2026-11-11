<script lang="ts">
  /**
   * The fields of the agent editor, in titled sections. A new agent's form has Identity (name,
   * identifier, description), Model (the model and its default effort), Instructions and Tools (a
   * table with one Asks select per tool, `agent-editor-tools.svelte`, chosen from a drawer,
   * `agent-editor-tool-picker.svelte`). The column is capped at Cinder's reading width, so the
   * fields do not stretch across a wide window (S35).
   *
   * A saved agent's form owns identity and instructions only (rows 41s to 41w): Name (required),
   * its identifier as one small monospaced line, Description, the Model as read-only text that
   * points to the Settings tab (`agent-editor-saved-model.svelte`), Instructions, the reference
   * documents the file reads (each with a remove button that takes effect with the next save),
   * and two read-only lines that point to the Access tab: the tools, and the guardrails with the
   * spend limit. The Access tab is where those are set (S31), each change there saving a version of
   * its own. A demoted block at the foot holds the delete (row 41x). Its identifier cannot change
   * here: the host has no operation that renames a saved agent, so the Change of row 41s, and the
   * dialog it opens (rows 42z, 43a), wait for one.
   *
   * A sticky bar at the foot holds what acts on the agent as a whole: the A2A switch, the save's
   * status ("Saving…" while it is in flight, rows 43j and 14w; "Not saved yet" on a new agent
   * otherwise, rows 43w and 44b; "Saved, Version 4" with a green check on a saved agent, row 41y),
   * and Cancel then Save (row 42n). Save stays enabled whatever the form holds (W35): a submit marks
   * the fields that stop it, and the page focuses the first. While a save is in flight Save is in
   * Cinder's loading state, which ignores a second press, Cancel stays available, and the text
   * fields are read-only until the server answers (row 43k). ⌘Enter submits the form from the
   * page. `card` has no field here; the state carries it through a save unchanged
   * (`agent-editor-state.svelte.ts`).
   *
   * A new agent's identifier is set from its name and shown once, small and monospaced, with a
   * Change that turns it into a field with a Reset back to the name's (rows 41e, 42x).
   *
   * The form owns no requests. The page that renders it sends a save and a delete, and says whether
   * one is in flight. The page does not render the form for a catalog with no model
   * (`agent-editor-no-provider.svelte`). The model is chosen in `agent-editor-model-field.svelte`,
   * and its default effort in `agent-editor-effort-field.svelte`.
   */
  import { Button, EmptyState, FormSection, Input, Textarea, Toggle } from '@lostgradient/cinder';
  import { Check, X } from '@lucide/svelte';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { agentTabPath } from '../../lib/agent-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { referenceSizeText } from '../agents/agent-presentation.ts';
  import { AGENT_EDITOR_FORM_ID } from './agent-editor-form-id.ts';
  import { followInApp } from './agent-editor-links.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorEffortField from './agent-editor-effort-field.svelte';
  import AgentEditorModelField from './agent-editor-model-field.svelte';
  import AgentEditorSavedModel from './agent-editor-saved-model.svelte';
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
    /** The version a saved agent is at, for the sticky bar's "Saved, Version 4" (row 41y). */
    savedRevision?: number | undefined;
    /** The agent's name as its file says it now, for the delete block (row 41x). */
    savedName?: string;
    /** The size in bytes of each reference document, as the Bureau reports them (row 41t). */
    referenceSizes?: readonly { readonly path: string; readonly size: number }[] | null;
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
    savedRevision,
    savedName = '',
    referenceSizes = null,
  }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const newCopy = AGENT_EDITOR_COPY.newAgent;
  let pickerOpen = $state(false);

  const creating = $derived(editor.mode === 'create');
  const errors = $derived(editor.shownErrors);
  const accessPath = $derived(agentTabPath(editor.identifier, 'access'));

  /** The size of the reference document at `path` as its row says it, or `undefined` when the Bureau did not say. */
  function sizeOf(path: string): string | undefined {
    return referenceSizeText(referenceSizes?.find((entry) => entry.path === path)?.size);
  }

  /** The spend limit as the guardrails line words it, or `null` when the form sets none. */
  const spendLimit = $derived(
    editor.spendPerRun.trim() === ''
      ? null
      : copy.edit.guardrails.spendPerRun(editor.spendPerRun.trim()),
  );

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
  <FormSection heading={copy.sections.identity} columns={1}>
    <Input
      id="agent-name"
      label={copy.nameLabel}
      description={copy.nameDescription}
      required
      readonly={saving}
      error={errors.name}
      bind:value={editor.name}
    />

    {#if !creating}
      <!-- A saved agent's identifier, once, small and monospaced (row 41s); it cannot be changed here. -->
      <p class="weft-agent-form__identifier" data-testid="agent-identifier">
        <span>{copy.edit.idLabel}</span>
        <code class="weft-agent-form__identifier-value">{editor.identifier}</code>
      </p>
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
        readonly={saving}
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
        readonly={saving}
        bind:value={editor.description}
      />
    </div>
  </FormSection>

  <!-- The section's title names each control below, so the control's own label is not shown twice. -->
  <FormSection heading={copy.sections.model} columns={1}>
    {#if creating}
      <AgentEditorModelField
        {editor}
        error={errors.model}
        loadFailed={editor.catalogMissing}
        retrying={retryingModels}
        onRetry={onRetryModels}
      />
      <AgentEditorEffortField {editor} />
    {:else}
      <AgentEditorSavedModel {editor} agentId={editor.identifier} />
    {/if}
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
      readonly={saving}
      bind:value={editor.instructions}
    />
  </FormSection>

  {#if !creating}
    <!-- Read with every chat. A document is taken off the list with the next save (row 41t). -->
    <FormSection
      heading={copy.edit.references.heading}
      meta={copy.edit.references.note}
      columns={1}
    >
      {#if editor.referencesKept.length === 0}
        <p class="weft-agent-form__note" data-testid="agent-no-references">
          {copy.edit.references.none}
        </p>
      {:else}
        <ul class="weft-agent-form__references" data-testid="agent-references">
          {#each keyedByOccurrence(editor.referencesKept, (path) => path) as { key, item: path } (key)}
            {@const size = sizeOf(path)}
            <li class="weft-agent-form__reference">
              <code>{path}</code>
              {#if size !== undefined}<span class="weft-agent-form__note">{size}</span>{/if}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={copy.edit.references.removeLabel(path)}
                disabled={saving}
                onclick={() => editor.removeReference(path)}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </FormSection>
  {/if}

  {#if creating}
    <FormSection
      as="fieldset"
      heading={copy.sections.tools}
      {...editor.catalogMissing
        ? {}
        : { meta: newCopy.toolCount(editor.chosenTools.length, editor.toolChoices.length) }}
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
  {:else}
    <!-- Tools, guardrails and the spend limit are set on the Access tab (S31); here they are read (rows 41v, 41w). -->
    <FormSection heading={copy.sections.tools} columns={1}>
      <p class="weft-agent-form__note" data-testid="agent-tools-summary">
        {copy.edit.tools.count(editor.chosenTools.length)}
        {copy.edit.tools.changeLead}<a
          href={router.href(accessPath)}
          onclick={(event) => followInApp(event, accessPath)}>{copy.edit.tools.accessTab}</a
        >{copy.edit.tools.changeTail}
      </p>
      <p class="weft-agent-form__note" data-testid="agent-guardrails-summary">
        {copy.edit.guardrails.summary(editor.guardrailIds, spendLimit)}
        {copy.edit.guardrails.changeLead}<a
          href={router.href(accessPath)}
          onclick={(event) => followInApp(event, accessPath)}>{copy.edit.guardrails.accessTab}</a
        >{copy.edit.guardrails.changeTail}
      </p>
    </FormSection>

    <!-- Demoted: the destructive action sits apart from Save (row 41x). -->
    <section class="weft-agent-form__danger" aria-labelledby="agent-delete-title">
      <div class="weft-agent-form__danger-text">
        <h2 id="agent-delete-title" class="weft-agent-form__danger-title">
          {copy.edit.deleteBlock.title}
        </h2>
        <p class="weft-agent-form__note">{copy.edit.deleteBlock.description(savedName)}</p>
      </div>
      <Button data-changes type="button" variant="danger" disabled={busy} onclick={onDelete}
        >{copy.deleteAction}</Button
      >
    </section>
  {/if}

  <div class="weft-agent-form__footer">
    <div class="weft-agent-form__a2a">
      <Toggle id="agent-a2a" label={copy.a2aLabel} bind:checked={editor.a2a} disabled={busy} />
      <p class="weft-agent-form__note">{copy.a2aDescription}</p>
    </div>

    <div class="weft-agent-form__actions">
      <p class="weft-agent-form__status" role="status" data-testid="agent-save-status">
        {#if saving}
          {newCopy.saving}
        {:else if creating}
          {copy.try.notSavedYet}
        {:else if savedRevision !== undefined}
          <Check aria-hidden="true" size={14} color="var(--cinder-status-success-text)" />
          {copy.edit.saved(savedRevision)}
        {/if}
      </p>
      <Button type="button" variant="ghost" onclick={onCancel}>{copy.cancelAction}</Button>
      <Button data-changes type="submit" variant="primary" loading={saving}>
        {creating ? copy.createAction : copy.saveAction}
      </Button>
    </div>
  </div>
</form>

<!-- A dialog inside the form would put its buttons in the form, so the picker sits beside it. -->
{#if creating && editor.toolChoices.length > 0}
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

  .weft-agent-form__references {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-agent-form__reference {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    align-items: center;
    font-size: var(--cinder-text-sm);
  }

  /* The size and the remove button sit at the end of the row. */
  .weft-agent-form__reference > :global(button) {
    margin-inline-start: auto;
  }

  /*
   * The delete, apart from the fields and above the sticky bar: a hairline over a title and its
   * sentence with the button at the right, never a box inside the form (row 41x).
   */
  .weft-agent-form__danger {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3) var(--cinder-space-4);
    align-items: center;
    justify-content: space-between;
    padding-block-start: var(--cinder-space-4);
    border-block-start: 1px solid var(--cinder-border);
  }

  .weft-agent-form__danger-text {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
  }

  .weft-agent-form__danger-title {
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: 600;
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
