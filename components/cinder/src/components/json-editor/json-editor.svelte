<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Controlled free-form JSON editor on a lazily loaded CodeMirror view with folding, schema completion, inline errors, and Format, backed by a native textarea.
   * @tag form
   * @tag json
   * @tag editor
   * @useWhen Editing arbitrary JSON source while preserving the exact string in parent-owned state.
   * @useWhen The value is genuinely free-form JSON and benefits from line numbers, folding, and completion.
   * @avoidWhen The value has a known shape that a guided form can edit. | schema-form
   * @avoidWhen Editing a JSON Schema with guided form and diff views. | json-schema-editor
   * @avoidWhen Displaying JSON without allowing changes. | json-viewer
   * @related textarea, json-schema-editor, json-viewer
   * @keyboardShortcut Tab | Moves focus out of the editor without trapping the keyboard.
   * @keyboardShortcut Shift+Alt+F | Formats the document as indented JSON.
   * @keyboardShortcut Ctrl+Space | Opens schema completions when a schema is provided.
   * @a11yNote The editable area is labelled by the visible label and described by the description and parse feedback; a native textarea with the same wiring serves until the editor loads and wherever it cannot.
   */
  export type { JsonEditorProps } from './json-editor.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { composeDescribedBy } from '../../_internal/field-control.ts';
  import FormFieldFrame from '../../_internal/form-field-frame.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import type { JsonEditorDynamicOptions, JsonEditorHandle } from './json-editor-enhancement.ts';
  import { formatJson, isBlankJson } from './json-editor-format.ts';
  import type { JsonEditorProps } from './json-editor.types.ts';

  let {
    id,
    value,
    label,
    description,
    error,
    rows = 8,
    validFeedbackVisible = true,
    schema,
    required = false,
    placeholder,
    disabled = false,
    readonly = false,
    onValueChange,
    class: className,
    autofocus = false,
    wrap,
    'aria-describedby': consumerDescribedBy,
    'aria-invalid': consumerInvalid,
    ...rest
  }: JsonEditorProps = $props();

  let draftValue = $state(untrack(() => value));
  let previousValue = untrack(() => value);
  let textareaNode: HTMLTextAreaElement | undefined = $state();
  let editorHostNode: HTMLElement | undefined = $state();
  // The mounted CodeMirror view. It stays undefined during server rendering, until the editor
  // chunk has loaded, and for good if that chunk fails to load, and the textarea serves meanwhile.
  let editorHandle: JsonEditorHandle | undefined = $state.raw();
  let resetSyncTimeout: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (value === previousValue) return;
    previousValue = value;
    draftValue = value;
  });

  function editorOptions(): JsonEditorDynamicOptions {
    return {
      disabled,
      readonly,
      wrap: wrap !== 'off',
      schema,
      placeholder: placeholderText,
      attributes: editorAttributes,
    };
  }

  $effect(() => {
    const parent = editorHostNode;
    if (!parent) return;

    let cancelled = false;
    let created: JsonEditorHandle | undefined;
    const mountEditor = async (): Promise<void> => {
      try {
        const { createJsonEditor } = await import('./json-editor-enhancement.ts');
        if (cancelled) return;
        const textarea = untrack(() => textareaNode);
        const hadFocus = textarea !== undefined && document.activeElement === textarea;
        created = untrack(() =>
          createJsonEditor({
            parent,
            document: draftValue,
            ...editorOptions(),
            onChange: (next) => {
              draftValue = next;
              onValueChange?.(next);
            },
          }),
        );
        if (hadFocus && textarea) {
          const length = created.view.state.doc.length;
          created.view.dispatch({
            selection: {
              anchor: Math.min(textarea.selectionStart, length),
              head: Math.min(textarea.selectionEnd, length),
            },
          });
        }
        editorHandle = created;
        if (hadFocus || untrack(() => autofocus)) created.focus();
      } catch {
        // The textarea is already a complete editor; a chunk that fails to load leaves it in place.
        created?.destroy();
        created = undefined;
      }
    };
    void mountEditor();

    return () => {
      cancelled = true;
      created?.destroy();
      created = undefined;
      editorHandle = undefined;
    };
  });

  $effect(() => {
    editorHandle?.setDocument(draftValue);
  });

  $effect(() => {
    editorHandle?.update(editorOptions());
  });

  function syncDraftAfterFormReset(): void {
    if (resetSyncTimeout !== undefined) clearTimeout(resetSyncTimeout);
    resetSyncTimeout = setTimeout(() => {
      resetSyncTimeout = undefined;
      if (textareaNode) draftValue = textareaNode.value;
    }, 0);
  }

  $effect(() => {
    const form = textareaNode?.form;
    if (!form) return;

    form.addEventListener('reset', syncDraftAfterFormReset);
    return () => {
      form.removeEventListener('reset', syncDraftAfterFormReset);
      if (resetSyncTimeout !== undefined) {
        clearTimeout(resetSyncTimeout);
        resetSyncTimeout = undefined;
      }
    };
  });

  const descriptionId = $derived(description ? `${id}-description` : undefined);
  const externalError = $derived(error || undefined);
  // An empty optional field is valid and reads "Not set": it earns no error and no "Valid JSON."
  const emptyIsValid = $derived(!required && isBlankJson(draftValue));
  const parseIsValid = $derived.by(() => {
    if (emptyIsValid) return true;
    try {
      JSON.parse(draftValue);
      return true;
    } catch {
      return false;
    }
  });
  const feedbackIsError = $derived(Boolean(externalError) || !parseIsValid);
  const normalizedConsumerInvalid = $derived(consumerInvalid ?? undefined);
  const consumerMarksInvalid = $derived(
    normalizedConsumerInvalid !== undefined &&
      normalizedConsumerInvalid !== false &&
      normalizedConsumerInvalid !== 'false',
  );
  const feedbackText = $derived(
    externalError ??
      (!parseIsValid
        ? 'Enter valid JSON.'
        : validFeedbackVisible && !consumerMarksInvalid && !emptyIsValid
          ? 'Valid JSON.'
          : undefined),
  );
  const feedbackId = $derived(feedbackText ? `${id}-feedback` : undefined);
  const describedBy = $derived(composeDescribedBy(descriptionId, feedbackId, consumerDescribedBy));
  const ariaInvalid = $derived(feedbackIsError ? 'true' : normalizedConsumerInvalid);
  const placeholderText = $derived(placeholder ?? (required ? undefined : 'Not set'));
  const editorAttributes = $derived.by(() => {
    const attributes: Record<string, string> = { 'aria-labelledby': `${id}-label` };
    // The editable area takes over the field's id once it is mounted, so the label and every
    // caller's reference to the id reach the editor and the hidden textarea is not a second match.
    if (editorHandle) attributes['id'] = id;
    if (describedBy) attributes['aria-describedby'] = describedBy;
    if (ariaInvalid === true || ariaInvalid === 'true') attributes['aria-invalid'] = 'true';
    if (required) attributes['aria-required'] = 'true';
    if (readonly) attributes['aria-readonly'] = 'true';
    if (disabled) attributes['aria-disabled'] = 'true';
    return attributes;
  });
  // With an external error the draft is not parsed, so Format stays available and simply does
  // nothing for source that is not valid JSON.
  const canFormat = $derived(
    !disabled && !readonly && (externalError ? true : parseIsValid && !isBlankJson(draftValue)),
  );

  function formatDraft(): void {
    if (readonly) return;
    if (editorHandle) {
      editorHandle.format();
      return;
    }
    const formatted = formatJson(draftValue);
    if (formatted === undefined || formatted === draftValue) return;
    draftValue = formatted;
    onValueChange?.(formatted);
  }

  // The label points at the textarea, which is hidden once the editor is mounted, so a click on it
  // is forwarded to the editor.
  function forwardLabelClick(event: MouseEvent): void {
    if (!editorHandle || !(event.target instanceof Element)) return;
    if (event.target.closest('label')) editorHandle.focus();
  }
</script>

{#snippet jsonControl()}
  <div
    class={classNames(
      'cinder-json-editor__input',
      wrap === 'off' && 'cinder-json-editor__input--nowrap',
    )}
    style:--_cinder-json-editor-rows={rows}
  >
    <div bind:this={editorHostNode} class="cinder-json-editor__editor"></div>
    <!-- svelte-ignore a11y_autofocus (Autofocus is an explicit caller option; the native attribute preserves its behavior before hydration.) -->
    <textarea
      bind:this={textareaNode}
      {...rest}
      id={editorHandle ? `${id}-textarea` : id}
      {rows}
      {autofocus}
      {wrap}
      {disabled}
      {readonly}
      placeholder={placeholderText}
      {required}
      hidden={editorHandle !== undefined}
      value={draftValue}
      spellcheck="false"
      class="cinder-json-editor__textarea"
      aria-describedby={describedBy}
      aria-invalid={ariaInvalid}
      oninput={(event) => {
        draftValue = event.currentTarget.value;
        onValueChange?.(draftValue);
      }}
      onfocus={() => editorHandle?.focus()}
      oninvalid={(event) => {
        // Native validation tries to focus the first invalid control, but once the editor mounts
        // this textarea is hidden and cannot take focus, so the visible editor takes it instead.
        const consumerHandler = rest.oninvalid;
        if (typeof consumerHandler === 'function') consumerHandler.call(event.currentTarget, event);
        editorHandle?.focus();
      }}
      {@attach (element) => {
        if (autofocus) element.focus();
      }}></textarea>
    <div class="cinder-json-editor__toolbar">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        label="Format"
        disabled={!canFormat}
        onclick={formatDraft}
      />
    </div>
  </div>
{/snippet}

{#snippet feedback()}
  {#if feedbackText}
    <p
      id={feedbackId}
      class={classNames(
        'cinder-json-editor__feedback',
        feedbackIsError && 'cinder-json-editor__feedback--error',
      )}
      role={feedbackIsError ? 'alert' : 'status'}
    >
      {feedbackText}
    </p>
  {/if}
{/snippet}

<!-- The `error` prop and JSON parse feedback are already merged into
     `feedbackText` above (see `externalError`/`feedbackText`), which can be
     either an error (role="alert") or a non-error valid-JSON status
     (role="status") — richer than FormFieldFrame's plain error slot, so it is
     rendered via `message` instead of `error`. `message` is passed
     unconditionally (the snippet guards its own content with
     `{#if feedbackText}`) rather than `feedbackText ? feedback : undefined` —
     Svelte 5 does not reliably re-toggle a child's `{#if messageProp}` when a
     snippet-typed prop's presence itself (not just content read inside the
     snippet) changes reactively across renders. -->
<FormFieldFrame
  {id}
  {label}
  {description}
  class={classNames('cinder-json-editor', className)}
  labelClass="cinder-json-editor__label"
  descriptionClass="cinder-json-editor__description"
  {descriptionId}
  control={jsonControl}
  message={feedback}
  onclick={forwardLabelClick}
/>
