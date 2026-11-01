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
   */
  import { SchemaForm, Textarea, validateSchemaFormValue } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import {
    declaredSchemaOf,
    describeIssue,
    formSchemaOf,
    type InputIssue,
  } from './run-setup-model.ts';

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
  }

  let {
    schema,
    onInput,
    formId = 'run-setup-input',
    jsonId = 'run-setup-json',
    testId = 'run-setup-input',
  }: Props = $props();

  const copy = WORKFLOW_COPY.runSetup;

  /** The schema as the form mounted with it. */
  const formSchema = untrack(() => formSchemaOf(schema));
  /** The schema the JSON editor's input is held to: the services may not check it themselves. */
  const jsonSchema = untrack(() =>
    formSchema === undefined ? declaredSchemaOf(schema) : undefined,
  );

  let jsonText = $state('');
  let jsonError = $state('');
  let issues = $state<readonly InputIssue[]>([]);
  let region: HTMLElement | undefined;
  /** The choices of the ask whose submit event has not been seen yet. */
  let asking: { readonly context: Context } | undefined;
  /**
   * The submit events the page asked for, which are the only ones that may start anything, each
   * with the choices it was asked with. A second ask while the form is still validating the first
   * is ignored by the form, which later answers with the first event, so every ask is kept; an ask
   * the form never answers (the input was invalid) leaves an entry that no later event can match.
   */
  const requested = new WeakMap<Event, { readonly context: Context }>();

  /**
   * Asks for the input: the form validates and `onInput` is called with a valid one. The JSON
   * editor reads its text here: empty is no input, and anything else must parse. A declared schema
   * that the form cannot draw still holds the input, because the engine does not check it unless
   * the workflow asks it to.
   */
  export function request(context: Context): void {
    if (formSchema === undefined) {
      void requestFromJson(context);
      return;
    }
    const form = region?.querySelector('form');
    if (form === null || form === undefined) return;
    asking = { context };
    form.requestSubmit();
  }

  async function requestFromJson(context: Context): Promise<void> {
    const text = jsonText.trim();
    let input: unknown;
    if (text !== '') {
      try {
        input = JSON.parse(text);
      } catch {
        jsonError = copy.invalidJson;
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
    if (formSchema !== undefined) issues = refused;
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
</script>

<div class="ib-workflow-input" bind:this={region} onsubmitcapture={noteSubmit} data-testid={testId}>
  {#if formSchema !== undefined}
    <SchemaForm data-changes id={formId} schema={formSchema} name={formId} {issues} {onSubmit} />
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
