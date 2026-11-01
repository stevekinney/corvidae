<script lang="ts" module>
  import type { ChatQuestionIssue, QuestionAnswerRecord } from './question-answer.ts';

  export type ChatQuestionProps = {
    /** The JSON Schema (draft 2020-12) the answer must satisfy; it also says which control to draw. */
    schema: Readonly<Record<string, unknown>>;
    /** Stable prefix for the ids of the controls this question draws. */
    id: string;
    /** The answer, once there is one. The question then reads "You answered …" with Change. */
    answer?: QuestionAnswerRecord | undefined;
    /** What the person gave last time, to start Change from. Never holds a secret. */
    initialValue?: unknown;
    /**
     * Whether the host answers free text through its composer. A free-text question then shows
     * "Answer below" and draws no field of its own; without it, a text field is drawn in place.
     */
    answerInComposer?: boolean | undefined;
    /** Whether an answer is being sent. */
    busy?: boolean | undefined;
    /** Why the host refused the last answer, shown on the fields the paths name. */
    issues?: readonly ChatQuestionIssue[] | undefined;
    /** Whether the last answer could not be sent for a reason the person cannot fix by editing. */
    failed?: boolean | undefined;
    /** Largest file a file question takes, in bytes. */
    maxFileSize?: number | undefined;
    /** Stores a file and answers its managed asset id, for a file question. */
    uploadFile?: ((file: File, signal: AbortSignal) => Promise<string>) | undefined;
    /** Called with a value that is ready to send. */
    onSubmit: (value: unknown) => void;
    /** Called when the person chooses Change on an answered question. */
    onChange?: (() => void) | undefined;
  };
</script>

<script lang="ts">
  import {
    Button,
    Checkbox,
    CheckboxGroup,
    FileUpload,
    Input,
    NumberInput,
    SchemaForm,
    Textarea,
  } from '@lostgradient/cinder';
  import type { FileUploadEntry } from '@lostgradient/cinder';

  import {
    dateTimeFromLocal,
    localMomentFromDateTime,
    localTimeFromTime,
    timeFromLocal,
  } from './question-answer.ts';
  import {
    acceptedMediaType,
    choicesOf,
    mediaTypeMatches,
    classifyQuestion,
    ratingBounds,
    ratingStepsOf,
    schemaKeyword,
    schemaNumber,
  } from './question-kind.ts';

  let {
    schema,
    id,
    answer,
    initialValue,
    answerInComposer = false,
    busy = false,
    issues = [],
    failed = false,
    uploadFile,
    maxFileSize,
    onSubmit,
    onChange,
  }: ChatQuestionProps = $props();

  const kind = $derived(classifyQuestion(schema));
  const choices = $derived(choicesOf(schema));
  const steps = $derived(ratingStepsOf(schema));
  const bounds = $derived(ratingBounds(schema));
  const errorText = $derived(issues.map((issue) => issue.message).join(' '));
  const errorProp = $derived(errorText === '' ? {} : { error: errorText });
  const errorId = $derived(`${id}-error`);

  // Draft state. A secret draft is cleared the moment it is handed over.
  let text = $state('');
  let timeText = $state('');
  let numberDraft = $state<number | null>(null);
  let picked = $state<unknown[]>([]);
  let rating = $state<unknown>(undefined);
  let otherOpen = $state(false);
  let files = $state<FileUploadEntry[]>([]);
  let uploadError = $state<string | undefined>();
  let uploadController: AbortController | undefined;

  // Start from what the person gave last time (Change), once per answer being reopened. A moment
  // is sent as RFC 3339 and edited as local fields, so it is converted back for them.
  $effect.pre(() => {
    if (initialValue === undefined) return;
    if (typeof initialValue === 'string' && kind === 'time') {
      text = localTimeFromTime(initialValue) ?? '';
    } else if (typeof initialValue === 'string' && kind === 'date-time') {
      const moment = localMomentFromDateTime(initialValue);
      text = moment?.date ?? '';
      timeText = moment?.time ?? '';
    } else if (typeof initialValue === 'string') text = initialValue;
    else if (typeof initialValue === 'number') {
      numberDraft = initialValue;
      rating = initialValue;
    } else if (Array.isArray(initialValue)) picked = [...(initialValue as unknown[])];
  });

  $effect(() => () => uploadController?.abort());

  const maxLength = $derived.by(() => {
    const own = schemaNumber(schema, 'maxLength');
    if (own !== undefined) return own;
    const branch = (schemaKeyword(schema, 'anyOf') as Record<string, unknown>[] | undefined)?.find(
      (candidate) => !Array.isArray(candidate['enum']),
    );
    return branch === undefined ? undefined : schemaNumber(branch, 'maxLength');
  });
  const maxLengthProp = $derived(maxLength === undefined ? {} : { maxlength: maxLength });
  const minItems = $derived(schemaNumber(schema, 'minItems') ?? 0);
  const maxItems = $derived(schemaNumber(schema, 'maxItems'));
  const canSendPicked = $derived(
    picked.length >= minItems && (maxItems === undefined || picked.length <= maxItems),
  );
  const title = $derived.by(() => {
    const own = schemaKeyword(schema, 'title');
    return typeof own === 'string' && own !== '' ? own : 'Your answer';
  });

  function sendText(): void {
    if (text === '') return;
    onSubmit(text);
  }

  function sendSecret(): void {
    if (text === '') return;
    const secret = text;
    text = '';
    onSubmit(secret);
  }

  function sendDate(): void {
    if (text === '' || (kind === 'date-time' && timeText === '')) return;
    if (kind === 'date') onSubmit(text);
    else if (kind === 'time') {
      const time = timeFromLocal(text);
      if (time !== undefined) onSubmit(time);
    } else {
      const moment = dateTimeFromLocal(`${text}T${timeText}`);
      if (moment !== undefined) onSubmit(moment);
    }
  }

  function togglePicked(value: unknown, on: boolean): void {
    picked = on ? [...picked, value] : picked.filter((candidate) => !Object.is(candidate, value));
  }

  function replaceFileEntry(entry: FileUploadEntry, patch: Partial<FileUploadEntry>): void {
    files = files.map((candidate) =>
      candidate.id === entry.id ? { ...candidate, ...patch } : candidate,
    );
  }

  const mediaType = $derived(acceptedMediaType(schema));
  const fileSizeLimit = $derived(maxFileSize ?? 10 * 1024 * 1024);

  async function acceptFile(accepted: File[]): Promise<void> {
    const file = accepted[0];
    if (file === undefined || uploadFile === undefined) return;
    // The drop zone filters too; this refuses a file that got past it before anything is sent.
    if (!mediaTypeMatches(mediaType, file.type) || file.size > fileSizeLimit) {
      uploadError = !mediaTypeMatches(mediaType, file.type)
        ? `${file.name} is not ${mediaType ?? 'an accepted type'}.`
        : `${file.name} is larger than the ${Math.round(fileSizeLimit / (1024 * 1024))} MB limit.`;
      return;
    }
    uploadController?.abort();
    const controller = new AbortController();
    uploadController = controller;
    uploadError = undefined;
    const entry: FileUploadEntry = { id: `${id}-file`, file, status: 'uploading' };
    files = [entry];
    try {
      const assetId = await uploadFile(file, controller.signal);
      if (controller.signal.aborted) return;
      replaceFileEntry(entry, { status: 'ready' });
      onSubmit(assetId);
    } catch {
      if (controller.signal.aborted) return;
      replaceFileEntry(entry, { status: 'error', error: 'The file could not be uploaded.' });
      uploadError = 'The file could not be uploaded. Try again.';
    }
  }
</script>

<div class="chat-question" data-question-kind={kind}>
  {#if answer !== undefined}
    <p class="chat-question-answer" role="status">
      <span class="chat-question-answer-label">You answered</span>
      <span class="chat-question-answer-value" data-question-answer>{answer.summary}</span>
    </p>
    {#if onChange !== undefined}
      <Button type="button" variant="ghost" size="sm" onclick={onChange}>Change</Button>
    {/if}
  {:else}
    {#if kind === 'choice' || kind === 'choice-other'}
      <div class="chat-question-choices" role="group" aria-label={title}>
        {#each choices as choice, index (String(choice.value))}
          <Button
            type="button"
            variant="secondary"
            class="chat-question-choice"
            disabled={busy}
            aria-label={choice.description === undefined ? undefined : choice.label}
            aria-describedby={choice.description === undefined
              ? undefined
              : `${id}-choice-${index}-description`}
            onclick={() => onSubmit(choice.value)}
          >
            <span class="chat-question-choice-text">
              <span class="chat-question-choice-label">{choice.label}</span>
              {#if choice.description !== undefined}
                <span
                  class="chat-question-choice-description"
                  id={`${id}-choice-${index}-description`}>{choice.description}</span
                >
              {/if}
            </span>
          </Button>
        {/each}
        {#if kind === 'choice-other' && !otherOpen}
          <Button
            type="button"
            variant="ghost"
            class="chat-question-choice"
            disabled={busy}
            onclick={() => (otherOpen = true)}
          >
            Something else…
          </Button>
        {/if}
      </div>
      {#if kind === 'choice-other' && otherOpen}
        <form
          class="chat-question-row"
          onsubmit={(event) => {
            event.preventDefault();
            sendText();
          }}
        >
          <Input
            id={`${id}-other`}
            label="Something else"
            bind:value={text}
            {...maxLengthProp}
            {...errorProp}
            disabled={busy}
          />
          <Button type="submit" variant="primary" disabled={busy || text === ''}>Send</Button>
        </form>
      {:else if errorText !== ''}
        <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
      {/if}
    {:else if kind === 'multiple'}
      <form
        class="chat-question-stack"
        onsubmit={(event) => {
          event.preventDefault();
          if (canSendPicked) onSubmit($state.snapshot(picked));
        }}
      >
        <CheckboxGroup label={title} {...errorProp}>
          {#each choices as choice, index (String(choice.value))}
            <Checkbox
              id={`${id}-choice-${index}`}
              label={choice.label}
              {...choice.description === undefined ? {} : { description: choice.description }}
              checked={picked.some((candidate) => Object.is(candidate, choice.value))}
              onValueChange={(next) => togglePicked(choice.value, next)}
              disabled={busy}
            />
          {/each}
        </CheckboxGroup>
        <Button type="submit" variant="primary" disabled={busy || !canSendPicked}>Send</Button>
      </form>
    {:else if kind === 'boolean'}
      <div class="chat-question-choices" role="group" aria-label={title}>
        <Button type="button" variant="secondary" disabled={busy} onclick={() => onSubmit(true)}>
          Yes
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onclick={() => onSubmit(false)}>
          No
        </Button>
      </div>
      {#if errorText !== ''}
        <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
      {/if}
    {:else if kind === 'text'}
      {#if answerInComposer}
        <p class="chat-question-hint">Answer below</p>
        {#if errorText !== ''}
          <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
        {/if}
      {:else}
        <form
          class="chat-question-stack"
          onsubmit={(event) => {
            event.preventDefault();
            sendText();
          }}
        >
          <Textarea
            id={`${id}-text`}
            label={title}
            bind:value={text}
            {...maxLengthProp}
            {...errorProp}
            disabled={busy}
          />
          <Button type="submit" variant="primary" disabled={busy || text === ''}>Send</Button>
        </form>
      {/if}
    {:else if kind === 'number'}
      <form
        class="chat-question-row"
        onsubmit={(event) => {
          event.preventDefault();
          if (numberDraft !== null) onSubmit(numberDraft);
        }}
      >
        <NumberInput
          id={`${id}-number`}
          label={title}
          value={numberDraft}
          onValueChange={(next) => (numberDraft = next)}
          min={schemaNumber(schema, 'minimum')}
          max={schemaNumber(schema, 'maximum')}
          step={schemaKeyword(schema, 'type') === 'integer' ? 1 : undefined}
          {...errorProp}
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy || numberDraft === null}>Send</Button
        >
      </form>
    {:else if kind === 'date' || kind === 'time' || kind === 'date-time'}
      <form
        class="chat-question-row"
        onsubmit={(event) => {
          event.preventDefault();
          sendDate();
        }}
      >
        <Input
          id={`${id}-moment`}
          label={kind === 'date-time' ? `${title}: date` : title}
          type={kind === 'time' ? 'time' : 'date'}
          bind:value={text}
          {...errorProp}
          disabled={busy}
        />
        {#if kind === 'date-time'}
          <Input
            id={`${id}-moment-time`}
            label={`${title}: time`}
            type="time"
            bind:value={timeText}
            disabled={busy}
          />
        {/if}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || text === '' || (kind === 'date-time' && timeText === '')}>Send</Button
        >
      </form>
    {:else if kind === 'rating'}
      <form
        class="chat-question-stack"
        onsubmit={(event) => {
          event.preventDefault();
          if (rating !== undefined) onSubmit(rating);
        }}
      >
        {#if steps.length === 0}
          <NumberInput
            id={`${id}-rating`}
            label={title}
            value={typeof rating === 'number' ? rating : null}
            onValueChange={(next) => (rating = next ?? undefined)}
            min={bounds?.minimum}
            max={bounds?.maximum}
            step={1}
            {...errorProp}
            disabled={busy}
          />
        {:else}
          <div class="chat-question-choices" role="radiogroup" aria-label={title}>
            {#each steps as step (String(step.value))}
              <Button
                type="button"
                variant={Object.is(rating, step.value) ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={Object.is(rating, step.value)}
                disabled={busy}
                onclick={() => (rating = step.value)}
              >
                {step.label}
              </Button>
            {/each}
          </div>
          {#if errorText !== ''}
            <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
          {/if}
        {/if}
        <Button type="submit" variant="primary" disabled={busy || rating === undefined}>Send</Button
        >
      </form>
    {:else if kind === 'secret'}
      <form
        class="chat-question-row"
        onsubmit={(event) => {
          event.preventDefault();
          sendSecret();
        }}
      >
        <Input
          id={`${id}-secret`}
          label={title}
          type="password"
          autocomplete="off"
          bind:value={text}
          {...errorProp}
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy || text === ''}>Send</Button>
      </form>
    {:else if kind === 'file'}
      {#if uploadFile === undefined}
        <p class="chat-question-hint">
          This chat cannot upload files, so it cannot take this answer.
        </p>
      {:else}
        <FileUpload
          id={`${id}-file-input`}
          {files}
          disabled={busy}
          {...mediaType === undefined ? {} : { accept: mediaType }}
          maxSize={fileSizeLimit}
          onFilesAccepted={(accepted) => void acceptFile(accepted)}
          onReject={(rejected) => (uploadError = rejected[0]?.message)}
        />
        {#if uploadError !== undefined}
          <p class="chat-question-error" role="alert">{uploadError}</p>
        {/if}
        {#if errorText !== ''}
          <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
        {/if}
      {/if}
    {:else}
      <SchemaForm
        {schema}
        {issues}
        value={initialValue}
        jsonEditable={false}
        onSubmit={(value) => onSubmit(value)}
      />
    {/if}
    {#if failed}
      <p class="chat-question-error" role="alert">The answer could not be sent. Try again.</p>
    {/if}
  {/if}
</div>

<style>
  .chat-question {
    display: grid;
    gap: var(--cinder-space-2);
    inline-size: 100%;
  }

  .chat-question-choices {
    display: grid;
    gap: var(--cinder-space-2);
  }

  .chat-question-choices :global(.chat-question-choice) {
    inline-size: 100%;
    justify-content: flex-start;
    white-space: normal;
    text-align: start;
  }

  .chat-question-choice-text {
    display: grid;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
  }

  .chat-question-choice-label,
  .chat-question-choice-description {
    overflow-wrap: anywhere;
  }

  .chat-question-choice-description {
    color: var(--cinder-text-secondary, inherit);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-normal, normal);
  }

  .chat-question-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--cinder-space-2);
  }

  .chat-question-stack {
    display: grid;
    gap: var(--cinder-space-2);
    justify-items: start;
  }

  .chat-question-answer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    margin: 0;
  }

  .chat-question-answer-label {
    color: var(--cinder-text-secondary, inherit);
  }

  .chat-question-answer-value {
    font-weight: var(--cinder-font-semibold);
    overflow-wrap: anywhere;
  }

  .chat-question-hint {
    margin: 0;
    color: var(--cinder-text-secondary, inherit);
  }

  .chat-question-error {
    margin: 0;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    background: var(--cinder-status-danger-background);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-status-danger-text);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }
</style>
