<script lang="ts" module>
  import type { AnswerSendResult } from './answer-hold.svelte.ts';
  import type { ChatQuestionIssue, QuestionAnswerRecord } from './question-answer.ts';
  import type { ChatLabels } from '../chat-labels.ts';
  import { resolveChatLabels } from '../chat-labels.ts';

  /**
   * The words of a one-click answer while it is held (see `undoMilliseconds`) and after it is sent.
   * Each is a function of what the person picked, so a host can say it its own way; the defaults
   * read "Answered Staging" beside an Undo (5 s) button, and then "You answered: Staging".
   */
  export type ChatQuestionHoldCopy = {
    /** The words before Undo while the answer is held. Default: `Answered <label>`. */
    held: (label: string, seconds: number) => string;
    /** The Undo action's label, with the seconds left. Default: `Undo (<seconds> s)`. */
    undo: (seconds: number) => string;
    /** The words once the answer was sent. Default: `You answered: <label>`. */
    sent: (label: string) => string;
    /** A note after the Undo action while the answer is held, such as what happens next. Default: none. */
    note?: string | undefined;
    /**
     * Text drawn under the chosen choice in place of its description once an answer is held or
     * sent, such as "Selected"; the other choices then show their labels alone. Default: none, so
     * every choice keeps its description.
     */
    selected?: string | undefined;
  };

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
    /**
     * Called with a value that is ready to send. A host that answers asynchronously can return a
     * promise; `false` or a rejection puts a held one-click answer back as an open question with
     * "The answer could not be sent. Try again."
     */
    onSubmit: (value: unknown) => AnswerSendResult;
    /**
     * How long a one-click answer (a choice, a yes or no) is held before `onSubmit` is called, in
     * milliseconds. While it is held the choice shows selected and one inline line reads "Answered
     * Staging" beside an Undo (5 s) button; Undo opens the question again. The count pauses while focus or the
     * pointer is inside the question, and an answer still held when the question goes away is sent
     * at once. Default `0`: a pick is sent as it is made. Typed and form answers are never held.
     */
    undoMilliseconds?: number | undefined;
    /** Called with `true` when a one-click answer becomes held and `false` when it is undone or sent. */
    onHoldChange?: ((held: boolean) => void) | undefined;
    /** What the held and sent lines say; any part left out keeps its default. */
    holdCopy?: Partial<ChatQuestionHoldCopy> | undefined;
    /**
     * Whether the host sends a structured answer (an object) from its own button, which names this
     * question's form with `form="<id>-form"`. The form then draws no submit button of its own.
     */
    externalSubmit?: boolean | undefined;
    /** Called when the person chooses Change on an answered question. */
    onChange?: (() => void) | undefined;
    labels?: Partial<ChatLabels> | undefined;
  };
</script>

<script lang="ts">
  import {
    Button,
    Check,
    Checkbox,
    CheckboxGroup,
    ChoiceGrid,
    ChoiceGridItem,
    FileUpload,
    Input,
    NumberInput,
    SchemaForm,
    Textarea,
  } from '@lostgradient/cinder';
  import type { FileUploadEntry } from '@lostgradient/cinder';

  import { formatCountdown } from '../../../utilities/format-countdown.ts';
  import { useAnnouncer } from '../../../utilities/use-announcer.svelte.ts';
  import { AnswerHold } from './answer-hold.svelte.ts';
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
    undoMilliseconds = 0,
    onHoldChange,
    holdCopy,
    externalSubmit = false,
    labels: labelOverrides,
  }: ChatQuestionProps = $props();

  const labels = $derived(resolveChatLabels(labelOverrides));

  const kind = $derived(classifyQuestion(schema));
  const choices = $derived(choicesOf(schema));
  const selectableChoices = $derived(
    kind === 'boolean'
      ? [
          { value: true, label: labels.yes },
          { value: false, label: labels.no },
        ]
      : choices,
  );
  const steps = $derived(ratingStepsOf(schema));
  const bounds = $derived(ratingBounds(schema));
  const errorText = $derived(issues.map((issue) => issue.message).join(' '));
  const errorProp = $derived(errorText === '' ? {} : { error: errorText });
  const errorId = $derived(`${id}-error`);

  // A one-click answer is held for `undoMilliseconds` before the host gets it. The hold calls the
  // latest `onSubmit` and `onHoldChange`, so a host that swaps them is never left with a stale one.
  const hold = new AnswerHold({
    milliseconds: () => undoMilliseconds,
    send: (value) => onSubmit(value),
    onHoldChange: (held) => onHoldChange?.(held),
  });
  const announcer = useAnnouncer();
  const copy = $derived<ChatQuestionHoldCopy>({
    held: (label) => `Answered ${label}`,
    undo: (seconds) => `Undo (${formatCountdown(seconds)})`,
    sent: (label) => `You answered: ${label}`,
    ...holdCopy,
  });
  let root = $state<HTMLElement | undefined>();
  let pointerInside = false;
  let focusInside = false;

  // The count waits while the person is in the question, by pointer or by keyboard.
  $effect(() => {
    const element = root;
    if (element === undefined) return;
    let active = true;
    const update = (): void => {
      // Flush after the focus event has finished. During question teardown Svelte dispatches a
      // focusout before running this effect's cleanup; the active/connected checks then discard
      // that event instead of mutating the hold from inside the destroy effect.
      queueMicrotask(() => {
        if (!active || !element.isConnected) return;
        hold.setPaused(pointerInside || focusInside);
      });
    };
    const enter = (): void => {
      pointerInside = true;
      update();
    };
    const leave = (): void => {
      pointerInside = false;
      update();
    };
    const focusIn = (): void => {
      focusInside = true;
      update();
    };
    const focusOut = (event: FocusEvent): void => {
      focusInside = event.relatedTarget instanceof Node && element.contains(event.relatedTarget);
      update();
    };
    element.addEventListener('pointerenter', enter);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    return () => {
      active = false;
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('focusin', focusIn);
      element.removeEventListener('focusout', focusOut);
    };
  });

  // A question that goes away with an answer still held sends it, rather than dropping it.
  $effect(() => () => hold.destroy());

  // Said once when the hold starts. The visible count ticks every second and is not a live region.
  let announcedFor: unknown = undefined;
  $effect(() => {
    if (!hold.held) {
      announcedFor = undefined;
      return;
    }
    if (announcedFor === hold.value) return;
    announcedFor = hold.value;
    const seconds = Math.max(1, Math.round(undoMilliseconds / 1000));
    announcer.announce(
      `Answered ${hold.label}. Undo available for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
    );
  });

  // Undo puts focus back on the choice that was picked, so the keyboard is where it was.
  function undo(): void {
    const picked = hold.pick;
    hold.undo();
    if (typeof picked !== 'number') return;
    queueMicrotask(() =>
      root?.querySelectorAll<HTMLElement>('.chat-question-choices [role="radio"]')[picked]?.focus(),
    );
  }

  /** Sends a one-click answer now, or holds it first when the question has an undo window. */
  function pickAnswer(value: unknown, label: string, key: string | number): void {
    if (busy || hold.phase !== 'open') return;
    if (undoMilliseconds <= 0) {
      submit(value);
      return;
    }
    hold.hold(value, label, key);
  }

  /** Hands an answer that needs no hold to the host. */
  function submit(value: unknown): void {
    void onSubmit(value);
  }

  // A host that sends the answer itself says afterwards, by clearing `busy` with a failure or the
  // reasons on its fields, that it was refused; the sent answer then comes back as an open question.
  let wasBusy = false;
  $effect(() => {
    const nowBusy = busy;
    const refused = failed || issues.length > 0;
    if (wasBusy && !nowBusy && refused) {
      hold.reopen();
    }
    wasBusy = nowBusy;
  });

  const holding = $derived(hold.phase !== 'open');
  const holdFailed = $derived(hold.failed);

  // Draft state. A secret draft is cleared the moment it is handed over.
  let text = $state('');
  let timeText = $state('');
  let numberDraft = $state<number | null>(null);
  let picked = $state<unknown[]>([]);
  const choiceSelection = $derived(hold.pick === undefined ? null : String(hold.pick));
  let rating = $state<unknown>(undefined);
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
    submit(text);
  }

  function sendSecret(): void {
    if (text === '') return;
    const secret = text;
    text = '';
    submit(secret);
  }

  function sendDate(): void {
    if (text === '' || (kind === 'date-time' && timeText === '')) return;
    if (kind === 'date') submit(text);
    else if (kind === 'time') {
      const time = timeFromLocal(text);
      if (time !== undefined) submit(time);
    } else {
      const moment = dateTimeFromLocal(`${text}T${timeText}`);
      if (moment !== undefined) submit(moment);
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

  // ChoiceGrid owns the radio semantics and roving keyboard focus. Use its function binding setter
  // as the user-selection boundary so hold reopen/phase changes cannot replay an old selection.
  function selectChoice(selection: string | null): void {
    if (selection === null || busy || hold.phase !== 'open') return;
    const index = Number(selection);
    if (!Number.isInteger(index)) return;
    const choice = selectableChoices[index];
    if (choice !== undefined) pickAnswer(choice.value, choice.label, index);
  }

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
      submit(assetId);
    } catch {
      if (controller.signal.aborted) return;
      replaceFileEntry(entry, { status: 'error', error: 'The file could not be uploaded.' });
      uploadError = 'The file could not be uploaded. Try again.';
    }
  }
</script>

<div
  class="chat-question"
  data-question-kind={kind}
  data-question-phase={hold.phase}
  bind:this={root}
>
  {#if answer !== undefined}
    <div class="chat-question-receipt">
      <p class="chat-question-answer" role="status">
        <span class="chat-question-answer-label">{labels.youAnswered}</span>
        <span class="chat-question-answer-value" data-question-answer>{answer.summary}</span>
      </p>
      {#if onChange !== undefined}
        <Button type="button" variant="secondary" size="sm" onclick={onChange}
          >{labels.change}</Button
        >
      {/if}
    </div>
  {:else}
    {#if kind === 'choice' || kind === 'choice-other'}
      <ChoiceGrid
        class="chat-question-choices"
        variant="card"
        size="sm"
        columns={1}
        ariaLabel={title}
        bind:value={() => choiceSelection, selectChoice}
      >
        {#each choices as choice, index (String(choice.value))}
          {@const description =
            holding && holdCopy?.selected !== undefined
              ? String(index) === choiceSelection
                ? holdCopy.selected
                : undefined
              : choice.description}
          <ChoiceGridItem
            value={String(index)}
            disabled={busy || holding}
            {...description === undefined ? {} : { description }}
          >
            <span class="chat-question-choice-label" dir="auto">{choice.label}</span>
          </ChoiceGridItem>
        {/each}
      </ChoiceGrid>
      {@render holdStatus()}
      {#if kind === 'choice-other' && !answerInComposer}
        <form
          class="chat-question-own"
          onsubmit={(event) => {
            event.preventDefault();
            sendText();
          }}
        >
          <Input
            id={`${id}-other`}
            label={labels.yourOwnAnswer}
            labelVisible={false}
            placeholder={labels.chooseAnswerPlaceholder}
            bind:value={text}
            {...maxLengthProp}
            {...errorProp}
            disabled={busy || holding}
            trailingInteractive
          >
            {#snippet trailing()}
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={busy || holding || text === ''}>{labels.answer}</Button
              >
            {/snippet}
          </Input>
        </form>
      {:else if errorText !== ''}
        <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
      {/if}
    {:else if kind === 'multiple'}
      <form
        class="chat-question-stack"
        onsubmit={(event) => {
          event.preventDefault();
          if (canSendPicked) submit($state.snapshot(picked));
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
        <Button type="submit" variant="primary" disabled={busy || !canSendPicked}
          >{labels.send}</Button
        >
      </form>
    {:else if kind === 'boolean'}
      <ChoiceGrid
        class="chat-question-choices"
        variant="card"
        size="sm"
        columns={1}
        ariaLabel={title}
        bind:value={() => choiceSelection, selectChoice}
      >
        {#each [{ value: true, label: labels.yes }, { value: false, label: labels.no }] as option, index (option.label)}
          <ChoiceGridItem value={String(index)} disabled={busy || holding}>
            <span class="chat-question-choice-label" dir="auto">{option.label}</span>
          </ChoiceGridItem>
        {/each}
      </ChoiceGrid>
      {@render holdStatus()}
      {#if errorText !== ''}
        <p class="chat-question-error" id={errorId} role="alert">{errorText}</p>
      {/if}
    {:else if kind === 'text'}
      {#if answerInComposer}
        <p class="chat-question-hint">{labels.answerBelow}</p>
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
          <Button type="submit" variant="primary" disabled={busy || text === ''}
            >{labels.send}</Button
          >
        </form>
      {/if}
    {:else if kind === 'number'}
      <form
        class="chat-question-row"
        onsubmit={(event) => {
          event.preventDefault();
          if (numberDraft !== null) submit(numberDraft);
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
        <Button type="submit" variant="primary" disabled={busy || numberDraft === null}
          >{labels.send}</Button
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
          disabled={busy || text === '' || (kind === 'date-time' && timeText === '')}
          >{labels.send}</Button
        >
      </form>
    {:else if kind === 'rating'}
      <form
        class="chat-question-stack"
        onsubmit={(event) => {
          event.preventDefault();
          if (rating !== undefined) submit(rating);
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
        <Button type="submit" variant="primary" disabled={busy || rating === undefined}
          >{labels.send}</Button
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
        <Button type="submit" variant="primary" disabled={busy || text === ''}>{labels.send}</Button
        >
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
        id={`${id}-form`}
        {schema}
        {issues}
        value={initialValue}
        jsonEditable={false}
        submitVisible={!externalSubmit}
        onSubmit={(value) => submit(value)}
      />
    {/if}
    {#if failed || holdFailed}
      <p class="chat-question-error" role="alert">{labels.answerFailed}</p>
    {/if}
  {/if}
  <div class="cinder-sr-only" aria-live="polite" aria-atomic="true">{announcer.message}</div>
</div>

{#snippet holdStatus()}
  {#if hold.phase === 'held'}
    <div class="chat-question-status" data-state="held">
      <Check class="cinder-icon-sm" aria-hidden="true" />
      <span class="chat-question-status-text">{copy.held(hold.label, hold.seconds)}</span>
      {#if holdCopy?.note !== undefined}
        <span class="chat-question-status-text">{holdCopy.note}</span>
      {/if}
      <Button type="button" variant="ghost-accent" size="xs" onclick={undo}>
        {copy.undo(hold.seconds)}
      </Button>
    </div>
  {:else if hold.phase === 'sent'}
    <div class="chat-question-status" data-state="sent">
      <Check class="cinder-icon-sm" aria-hidden="true" />
      <span class="chat-question-status-text">{copy.sent(hold.label)}</span>
    </div>
  {/if}
{/snippet}

<style>
  .chat-question {
    display: grid;
    gap: var(--cinder-space-2);
    inline-size: 100%;
  }

  /* One column of cards. Cinder's cards own their rest border, centred label and equal rows. */
  .chat-question-choices {
    display: grid;
    gap: var(--cinder-space-2-5, 0.625rem);
  }

  .chat-question-choices :global(.cinder-choice-grid-item[data-cinder-variant='card']) {
    padding-block: var(--cinder-space-2);
    gap: var(--cinder-space-2);
  }

  .chat-question-choices
    :global(
      .cinder-choice-grid-item[data-cinder-variant='card'] .cinder-choice-grid-item__description
    ) {
    flex: 1 1 auto;
    line-height: var(--cinder-leading-tight, 1.25);
  }

  /* A description follows its title on the title's line when the whole of it fits, else it wraps below. */
  .chat-question-choices
    :global(.cinder-choice-grid-item[data-cinder-variant='card'] .cinder-choice-grid-item__card) {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--cinder-space-2);
    row-gap: 0;
  }

  .chat-question-choice-label {
    min-inline-size: 0;
    overflow-wrap: anywhere;
    font-weight: var(--cinder-font-semibold);
  }

  /* One inline line inside the question: what was answered, and the Undo that is still open. */
  .chat-question-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    color: var(--cinder-text-default);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  .chat-question-own {
    inline-size: 100%;
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

  .chat-question-receipt {
    /* Change reaches 44px by a hit area that overhangs the receipt; the message line under the
     * card stacks at 1, so the receipt stacks above it. */
    position: relative;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: var(--cinder-space-2);
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
