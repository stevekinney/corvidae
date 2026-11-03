<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Controlled free-form JSON editor in one frame: a toolbar with validity status and Format over a lazily loaded CodeMirror view with marked problem lines, backed by a native textarea.
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
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Check from '@lucide/svelte/icons/check';
  import Lock from '@lucide/svelte/icons/lock';
  import { untrack } from 'svelte';
  import { composeDescribedBy } from '../../_internal/field-control.ts';
  import FormFieldFrame from '../../_internal/form-field-frame.svelte';
  import { phoneViewport } from '../../_internal/phone-viewport.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import type { JsonEditorDynamicOptions, JsonEditorHandle } from './json-editor-enhancement.ts';
  import { formatJson, isBlankJson } from './json-editor-format.ts';
  import { locateJsonProblem } from './json-editor-problem.ts';
  import type { JsonEditorProps } from './json-editor.types.ts';

  let {
    id,
    value,
    label,
    description,
    error,
    rows = 8,
    validFeedbackVisible = true,
    statusLabel,
    diagnostics,
    example = '{ "key": "value" }',
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
  // Below 640px a long line wraps instead of scrolling sideways, unless `wrap` says otherwise.
  const wrapsLines = $derived(wrap === undefined ? phoneViewport.current : wrap !== 'off');

  $effect(() => {
    if (value === previousValue) return;
    previousValue = value;
    draftValue = value;
  });

  function editorOptions(): JsonEditorDynamicOptions {
    return {
      disabled,
      readonly,
      wrap: wrapsLines,
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
  const blank = $derived(isBlankJson(draftValue));
  // An empty optional field is valid and reads "Empty": it earns no error and no "Valid JSON."
  const emptyIsValid = $derived(!required && blank);
  // Where the source stops parsing, located by the editor rather than read from an engine message.
  // With an external error the draft is not parsed: the caller has already said what is wrong, and
  // a document too large to accept should not be scanned for nothing.
  const parseProblem = $derived(blank || externalError ? undefined : locateJsonProblem(draftValue));
  const parseIsValid = $derived(blank ? !required : parseProblem === undefined);
  const feedbackIsError = $derived(Boolean(externalError) || !parseIsValid);
  const normalizedConsumerInvalid = $derived(consumerInvalid ?? undefined);
  const consumerMarksInvalid = $derived(
    normalizedConsumerInvalid !== undefined &&
      normalizedConsumerInvalid !== false &&
      normalizedConsumerInvalid !== 'false',
  );
  // The lines the editor marks: the line where the source stops parsing, else the caller's lines.
  const problems = $derived(
    parseProblem
      ? [{ line: parseProblem.line, message: parseProblem.detail }]
      : (diagnostics ?? []),
  );
  const toolbarStatus = $derived.by(
    (): { tone: 'muted' | 'success' | 'danger'; text: string; line?: number } | undefined => {
      if (readonly) return { tone: 'muted', text: 'Read only' };
      if (emptyIsValid) return { tone: 'muted', text: 'Empty' };
      if (blank) return { tone: 'danger', text: 'Enter valid JSON' };
      if (externalError) return undefined;
      if (parseProblem) {
        return {
          tone: 'danger',
          text: `Line ${parseProblem.line}: ${parseProblem.summary}`,
          line: parseProblem.line,
        };
      }
      if (!validFeedbackVisible || consumerMarksInvalid) return undefined;
      return { tone: 'success', text: statusLabel ?? 'Valid JSON' };
    },
  );
  const statusId = $derived(toolbarStatus ? `${id}-status` : undefined);
  const feedbackId = $derived(externalError ? `${id}-feedback` : undefined);
  const describedBy = $derived(
    composeDescribedBy(descriptionId, statusId, feedbackId, consumerDescribedBy),
  );
  const ariaInvalid = $derived(feedbackIsError ? 'true' : normalizedConsumerInvalid);
  const placeholderText = $derived(placeholder ?? `e.g. ${example}`);
  // The frame goes red for what the caller says is wrong; a parse problem is marked at its line.
  const frameInvalid = $derived(Boolean(externalError) || consumerMarksInvalid);
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
    !disabled && !readonly && (externalError ? true : parseIsValid && !blank),
  );

  $effect(() => {
    editorHandle?.setProblems(problems);
  });

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

  /**
   * Move the caret to the start of a one-based line and focus the editor, scrolling the line into
   * view. A line past the end goes to the last line. Use it to take a person to a problem the page
   * found, such as when a Save button is pressed over invalid JSON.
   */
  export function focusLine(line: number): void {
    if (editorHandle) {
      editorHandle.focusLine(line);
      return;
    }
    const textarea = textareaNode;
    if (!textarea) return;
    const lines = draftValue.split('\n');
    const index = Math.min(Math.max(1, Math.trunc(line)), lines.length) - 1;
    const offset = lines.slice(0, index).reduce((total, current) => total + current.length + 1, 0);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
  }

  /**
   * Focus the first marked line: the line where the source stops parsing, else the first line a
   * caller marked through `diagnostics`. While an `error` is set the editor does not mark the
   * parse problem, but this still finds it, so a Save pressed over a field the caller has refused
   * lands at the line to fix. With nothing to point at it focuses the editor.
   */
  export function focusProblem(): void {
    const first = problems[0] ?? (blank ? undefined : locateJsonProblem(draftValue));
    if (first) {
      focusLine(first.line);
    } else if (editorHandle) {
      editorHandle.focus();
    } else {
      textareaNode?.focus();
    }
  }

  // The label points at the textarea, which is hidden once the editor is mounted, so a click on it
  // is forwarded to the editor.
  function forwardLabelClick(event: MouseEvent): void {
    if (!editorHandle || !(event.target instanceof Element)) return;
    if (event.target.closest('label')) editorHandle.focus();
  }
</script>

{#snippet statusIcon(tone: 'muted' | 'success' | 'danger')}
  {#if readonly}
    <Lock size={14} aria-hidden="true" />
  {:else if tone === 'success'}
    <Check size={14} aria-hidden="true" />
  {:else if tone === 'danger'}
    <CircleAlert size={14} aria-hidden="true" />
  {/if}
{/snippet}

{#snippet jsonControl()}
  <div
    class={classNames(
      'cinder-json-editor__input',
      !wrapsLines && 'cinder-json-editor__input--nowrap',
      disabled && 'cinder-json-editor__input--disabled',
      frameInvalid && 'cinder-json-editor__input--invalid',
    )}
    style:--_cinder-json-editor-rows={rows}
  >
    <div class="cinder-json-editor__toolbar">
      <span class="cinder-json-editor__tag" aria-hidden="true">JSON</span>
      <div class="cinder-json-editor__toolbar-end">
        <!-- The live region is always mounted, so a status that appears or changes is announced. -->
        <div
          id={statusId}
          class={classNames(
            'cinder-json-editor__status',
            toolbarStatus && `cinder-json-editor__status--${toolbarStatus.tone}`,
          )}
          role="status"
        >
          {#if toolbarStatus}
            {@render statusIcon(toolbarStatus.tone)}
            {#if toolbarStatus.line !== undefined}
              {@const problemLine = toolbarStatus.line}
              <button
                type="button"
                class="cinder-json-editor__status-action"
                {disabled}
                onclick={() => focusLine(problemLine)}
              >
                {toolbarStatus.text}
              </button>
            {:else}
              <span>{toolbarStatus.text}</span>
            {/if}
          {/if}
        </div>
        {#if !readonly}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            label="Format"
            disabled={!canFormat}
            onclick={formatDraft}
          />
        {/if}
      </div>
    </div>
    <div class="cinder-json-editor__body">
      <div bind:this={editorHostNode} class="cinder-json-editor__editor"></div>
      <!-- svelte-ignore a11y_autofocus (Autofocus is an explicit caller option; the native attribute preserves its behavior before hydration.) -->
      <textarea
        bind:this={textareaNode}
        {...rest}
        id={editorHandle ? `${id}-textarea` : id}
        {rows}
        {autofocus}
        wrap={wrapsLines ? 'soft' : 'off'}
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
          if (typeof consumerHandler === 'function')
            consumerHandler.call(event.currentTarget, event);
          editorHandle?.focus();
        }}
        {@attach (element) => {
          if (autofocus) element.focus();
        }}></textarea>
    </div>
  </div>
{/snippet}

{#snippet feedback()}
  {#if externalError}
    <p
      id={feedbackId}
      class="cinder-json-editor__feedback cinder-json-editor__feedback--error"
      role="alert"
    >
      <CircleAlert size={14} aria-hidden="true" />
      <span>{externalError}</span>
    </p>
  {/if}
{/snippet}

<!-- Validity lives in the frame's toolbar. Only the caller's `error` prop is rendered below the
     field, through `message` rather than `error` because it carries a glyph FormFieldFrame's
     plain error slot has no room for. `message` is passed unconditionally (the snippet guards
     its own content with `{#if externalError}`) rather than `externalError ? feedback :
     undefined` — Svelte 5 does not reliably re-toggle a child's `{#if messageProp}` when a
     snippet-typed prop's presence itself changes reactively across renders. -->
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
