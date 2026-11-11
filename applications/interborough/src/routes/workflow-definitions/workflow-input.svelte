<script lang="ts" generics="Context">
  /**
   * The input of a workflow, asked for the same way wherever a page starts or schedules one: the run
   * setup page and the page that makes a schedule.
   *
   * The input is a Cinder `SchemaForm` when the workflow declares an object schema with fields, and
   * a JSON editor otherwise. The page's own action is outside the form, so the form's submit button
   * is not drawn, and a submit counts only when the page asked for it with `request`: Enter in a
   * field validates the input and shows its errors but never starts anything. The schema is read
   * once when the component mounts, because the form starts over when its schema changes, and a
   * background reload must not discard what was typed.
   *
   * `request` takes the choices the page made when it asked, and `onInput` is handed them back with
   * the validated input, so a choice made while the form was validating cannot change what is sent.
   * A refusal from the service goes back in through `refuse`, which puts it on the fields it names.
   *
   * With `composed`, a drawn form can be swapped for a JSON editor and back (the run setup page's
   * Edit as JSON and Back to form). The text starts as the form's draft; while it parses, the
   * parsed value is the draft the form reopens with, so nothing typed is dropped, and Back to form
   * is off, with the line to fix in its label, while it does not. A schema that holds a concealed
   * field (a secret or write-only string, however deeply nested) is never offered as JSON, because
   * the editor would print the value.
   */
  import {
    Button,
    JsonEditor,
    SchemaForm,
    Textarea,
    schemaFormInitialDraft,
    schemaHoldsConcealedField,
    validateSchemaFormValue,
  } from '@lostgradient/cinder';
  import { tick, untrack } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import {
    declaredSchemaOf,
    describeIssue,
    firstMissingField,
    formSchemaOf,
    type InputIssue,
    type InputState,
  } from './run-setup-model.ts';
  import { locateJsonProblem } from './workflow-source.ts';

  interface Props {
    /** The JSON Schema the input is described by, or `undefined` when the workflow declares none. */
    schema: unknown;
    /** What the page does with an input that passed the form's own checks, and the choices it asked with. */
    onInput: (input: unknown, context: Context) => void;
    /** The id of the form, which the Bureau's field problems are shown on. */
    formId?: string;
    /** The id of the JSON editor. */
    jsonId?: string;
    /** The `data-testid` of the region that holds the form or the editor. */
    testId?: string;
    /** Offers Edit as JSON and Back to form for a schema the form draws. */
    composed?: boolean;
    /** Told what the input holds as it changes: the form's draft, or whether the JSON text parses. */
    onChange?: (state: InputState) => void;
    /** Withholds Edit as JSON, while the page has made the input read-only (a start in flight). */
    locked?: boolean;
  }

  let {
    schema,
    onInput,
    formId = 'run-setup-input',
    jsonId = 'run-setup-json',
    testId = 'run-setup-input',
    composed = false,
    onChange,
    locked = false,
  }: Props = $props();

  const copy = WORKFLOW_COPY.runSetup;

  /** The schema as the form mounted with it. */
  const formSchema = untrack(() => formSchemaOf(schema));
  /** The schema the JSON editor's input is held to: the services may not check it themselves. */
  const jsonSchema = untrack(() => declaredSchemaOf(schema));
  /** Whether the schema holds a value the JSON editor would print and must not. */
  const concealed = untrack(() => schemaHoldsConcealedField(schema));
  /** Whether the drawn form can be swapped for the JSON editor. */
  const offersJson = $derived(composed && formSchema !== undefined && !concealed);

  let jsonText = $state('');
  let jsonError = $state('');
  let issues = $state<readonly InputIssue[]>([]);
  /** Whether the JSON editor stands in for the drawn form. */
  let editingJson = $state(false);
  /** What the form holds: its seeded draft until an edit reports another, then what the JSON parsed to. */
  let draft = $state.raw<unknown>(
    formSchema === undefined ? undefined : schemaFormInitialDraft(formSchema),
  );
  let region: HTMLElement | undefined;
  let editor = $state<{ focusProblem: () => void }>();
  /** The choices of the ask whose submit event has not been seen yet. */
  let asking: { readonly context: Context } | undefined;
  /**
   * The submit events the page asked for, which are the only ones that may start anything, each
   * with the choices it was asked with. A second ask while the form is still validating the first
   * is ignored by the form, which later answers with the first event, so every ask is kept; an ask
   * the form never answers (the input was invalid) leaves an entry that no later event can match.
   */
  const requested = new WeakMap<Event, { readonly context: Context }>();

  /** The JSON text as a value, or `undefined` while it does not parse. */
  const parsed = $derived.by((): { readonly value: unknown } | undefined => {
    try {
      return { value: JSON.parse(jsonText) as unknown };
    } catch {
      return undefined;
    }
  });
  /** Where the text stops being JSON, which the way back names. */
  const problem = $derived(editingJson ? locateJsonProblem(jsonText) : null);
  /** The way back is off while the text does not parse, or parses to something a form cannot hold. */
  const backBlocked = $derived(parsed === undefined || !isRecord(parsed.value));
  const inputState = $derived<InputState>(
    editingJson ? { mode: 'json', valid: parsed !== undefined } : { mode: 'form', value: draft },
  );
  $effect(() => {
    // The page's handler is not a dependency: only a change of what the input holds is told.
    const next = inputState;
    untrack(() => onChange?.(next));
  });

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Asks for the input: the form validates and `onInput` is called with a valid one. The JSON
   * editor reads its text here: empty is no input, and anything else must parse. A declared schema
   * that the form cannot draw still holds the input, because the engine does not check it unless
   * the workflow asks it to.
   */
  export function request(context: Context): void {
    if (formSchema === undefined || editingJson) {
      void requestFromJson(context);
      return;
    }
    const form = region?.querySelector('form');
    if (form === null || form === undefined) return;
    // A required text field left empty passes the form's own check (the key is there, with no text
    // in it), so the form is told it is missing, and focus goes to it as it does for its own.
    const missing = composed ? firstMissingField(formSchema, draft) : undefined;
    if (missing !== undefined) {
      issues = [{ path: [missing.key], message: copy.fieldRequired(missing.name) }];
      void tick().then(() => region?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    asking = { context };
    form.requestSubmit();
  }

  async function requestFromJson(context: Context): Promise<void> {
    const text = jsonText.trim();
    let input: unknown;
    if (editingJson && text === '') {
      jsonError = copy.jsonRequired;
      return;
    }
    if (text !== '') {
      try {
        input = JSON.parse(text);
      } catch {
        // The editor marks the line, so the ask takes a person there instead of saying it twice.
        if (editingJson) editor?.focusProblem();
        else jsonError = copy.invalidJson;
        return;
      }
    }
    if (jsonSchema !== undefined) {
      const result = await validateSchemaFormValue(jsonSchema, input);
      if (!result.valid) {
        jsonError = result.issues.map(describeIssue).join(' ');
        return;
      }
    }
    onInput(input, context);
  }

  /** Puts a service's refusal of the input on the fields it names, or on the editor. */
  export function refuse(refused: readonly InputIssue[]): void {
    if (formSchema !== undefined && !editingJson) issues = refused;
    else jsonError = refused.map((issue) => issue.message).join(' ');
  }

  /** Takes the problems off the fields, as a new attempt starts. */
  export function clear(): void {
    issues = [];
    jsonError = '';
  }

  /** Marks the submit the page asked for, before the form handles it. */
  function noteSubmit(event: Event): void {
    // A submit that was not asked for leaves a pending ask alone: it only ever fails to match.
    if (asking !== undefined) requested.set(event, asking);
    asking = undefined;
  }

  function onSubmit(value: unknown, event: Event): void {
    const ask = requested.get(event);
    if (ask === undefined) return;
    onInput(value, ask.context);
  }

  function trackDraft(value: unknown): void {
    draft = value;
  }

  function editAsJson(): void {
    if (!offersJson) return;
    jsonText = JSON.stringify(draft ?? {}, null, 2);
    issues = [];
    jsonError = '';
    editingJson = true;
  }

  function backToForm(): void {
    if (backBlocked) return;
    jsonError = '';
    editingJson = false;
  }

  function changeJson(next: string): void {
    jsonText = next;
    jsonError = '';
    try {
      const value: unknown = JSON.parse(next);
      if (isRecord(value)) draft = value;
    } catch {
      // The editor says the text does not parse, and the form keeps the last text that did.
    }
  }
</script>

<div class="ib-workflow-input" bind:this={region} onsubmitcapture={noteSubmit} data-testid={testId}>
  {#if composed && formSchema !== undefined}
    <div class="ib-workflow-input__lead" data-testid="run-setup-input-lead">
      <p class="ib-workflow-input__description">
        {#if !editingJson}
          {copy.inputDescription}
        {:else if backBlocked}
          {copy.jsonEditingInvalid}
        {:else}
          {copy.jsonEditing}
        {/if}
      </p>
      {#if editingJson}
        <Button
          variant="ghost-accent"
          size="sm"
          disabled={backBlocked}
          data-testid="run-setup-back-to-form"
          onclick={backToForm}
          >{backBlocked ? copy.backToFormBlocked(problem?.line ?? 1) : copy.backToForm}</Button
        >
      {:else if offersJson && !locked}
        <Button
          variant="ghost-accent"
          size="sm"
          data-testid="run-setup-edit-as-json"
          onclick={editAsJson}>{copy.editAsJson}</Button
        >
      {/if}
    </div>
  {/if}
  {#if editingJson}
    <JsonEditor
      bind:this={editor}
      id={jsonId}
      label={copy.jsonEditorLabel}
      rows={12}
      value={jsonText}
      error={jsonError}
      onValueChange={changeJson}
    />
  {:else if formSchema !== undefined}
    <SchemaForm
      data-changes
      id={formId}
      schema={formSchema}
      name={formId}
      variant="input"
      {issues}
      {onSubmit}
      {...composed ? { value: draft, onDraftChange: trackDraft, jsonEditable: false } : {}}
    />
  {:else}
    <Textarea
      id={jsonId}
      label={copy.jsonLabel}
      description={copy.jsonDescription}
      variant="code"
      rows={8}
      bind:value={jsonText}
      error={jsonError}
      oninput={() => (jsonError = '')}
    />
  {/if}
</div>

<style>
  .ib-workflow-input {
    min-width: 0;
  }

  /* The description of the Input section, and the link that swaps the form for JSON at its right. */
  .ib-workflow-input__lead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    align-items: center;
    justify-content: space-between;
    margin-block-end: var(--cinder-space-3);
  }

  .ib-workflow-input__description {
    margin: 0;
    min-width: 0;
    color: var(--cinder-text-muted);
  }

  /*
   * A field name or description with a word no line can break at wraps instead of widening the
   * page. Cinder gives a field's description break-word, which unlike anywhere does not shrink the
   * field's minimum width, so every element under the form is given anywhere.
   */
  .ib-workflow-input,
  .ib-workflow-input :global(*) {
    overflow-wrap: anywhere;
  }

  /* The page holds the primary action, so the form's own submit button is not drawn. */
  .ib-workflow-input :global(button[type='submit']) {
    display: none;
  }
</style>
