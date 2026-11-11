<script lang="ts" module>
  import type { ChatQuestionDockLabels } from './question-dock-labels.ts';
  import type { DockedQuestionTarget } from './question-store.svelte.ts';

  export type ChatQuestionDockProps = {
    /** Stable prefix for the ids of the dock's parts. */
    id: string;
    /** The open question to ask. */
    question: DockedQuestionTarget;
    /** Where this question falls among those asked together, counting from 1. */
    position: number;
    /** How many questions were asked together; the progress shows only when it is more than 1. */
    total: number;
    /** Called when the person chooses to reply in chat instead. */
    onReply: () => void;
    /** The words, any of which the host can replace. */
    labels?: Partial<ChatQuestionDockLabels> | undefined;
  };
</script>

<script lang="ts">
  /**
   * A pending question that has choices, docked in place of the composer (COR-2278, row P3): a
   * warning that the run needs the person, a fieldset named for what the agent is asking, radio
   * cards at least 52 px tall with the keys 1, 2 and 3 for the choices, and Something else, which
   * opens a field. The answer is always explicit: a choice only selects, and Answer sends it.
   * Reply in chat instead (secondary, on the left) gives the composer back; Answer (primary, on the
   * right) stays off, with its reason in view, until there is something to send. The keys work only
   * while focus is inside the dock and never inside a field, so they cannot take over typing.
   */
  import { Button, ChoiceGrid, ChoiceGridItem, CircleAlert, Input } from '@lostgradient/cinder';
  import { tick } from 'svelte';

  import { DEFAULT_QUESTION_DOCK_LABELS, OTHER_CHOICE } from './question-dock-labels.ts';
  import { choicesOf, classifyQuestion, type QuestionChoice } from './question-kind.ts';

  let {
    id,
    question,
    position,
    total,
    onReply,
    labels: labelOverrides,
  }: ChatQuestionDockProps = $props();

  const labels = $derived<ChatQuestionDockLabels>({
    ...DEFAULT_QUESTION_DOCK_LABELS,
    ...labelOverrides,
  });
  const kind = $derived(classifyQuestion(question.schema));
  const choices = $derived<readonly QuestionChoice[]>(
    kind === 'boolean'
      ? [
          { value: true, label: 'Yes' },
          { value: false, label: 'No' },
        ]
      : choicesOf(question.schema),
  );
  const allowsOther = $derived(kind === 'choice-other');
  const choiceCount = $derived(choices.length + (allowsOther ? 1 : 0));

  let root = $state<HTMLFormElement | undefined>();
  let selected = $state<string | null>(null);
  let text = $state('');

  const pickingOther = $derived(selected === OTHER_CHOICE);
  const ready = $derived(selected !== null && (!pickingOther || text.trim() !== ''));
  const reason = $derived(pickingOther ? labels.typeHint : labels.chooseHint);
  const errorText = $derived(question.issues.map((issue) => issue.message).join(' '));

  const questionId = $derived(`${id}-question`);
  const legendId = $derived(`${id}-legend`);
  const hintId = $derived(`${id}-hint`);
  const errorId = $derived(`${id}-error`);

  /** The answer the chosen card stands for, or the person's own words. */
  function chosenValue(): unknown {
    if (selected === OTHER_CHOICE) return text.trim();
    const choice = selected === null ? undefined : choices[Number(selected)];
    return choice?.value;
  }

  function send(event: SubmitEvent): void {
    event.preventDefault();
    if (!ready || question.busy) return;
    void question.submit(chosenValue());
  }

  /** Focuses the own-answer field once Something else has opened it. */
  async function focusOwnAnswer(): Promise<void> {
    await tick();
    root?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')?.focus();
  }

  // The keys 1 to 9 choose a card, but only from the dock itself and never from a field.
  function chooseByKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!/^[1-9]$/u.test(event.key)) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    ) {
      return;
    }
    const index = Number(event.key) - 1;
    if (index >= choiceCount || question.busy) return;
    event.preventDefault();
    const next = index < choices.length ? String(index) : OTHER_CHOICE;
    selected = next;
    if (next === OTHER_CHOICE) void focusOwnAnswer();
  }

  // Choosing Something else with the pointer or the arrow keys opens the field the same way.
  let wasOther = false;
  $effect(() => {
    const now = pickingOther;
    if (now && !wasOther) void focusOwnAnswer();
    wasOther = now;
  });
</script>

<!-- The keys 1 to 9 are heard only while focus is inside the dock, and never from a field. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
  bind:this={root}
  class="chat-question-dock"
  data-chat-question-dock
  data-chat-question-id={question.toolCallId}
  onsubmit={send}
  onkeydown={chooseByKey}
>
  <div class="chat-question-dock-header">
    <span class="chat-question-dock-needs" data-chat-question-needs>
      <CircleAlert class="cinder-icon-sm" aria-hidden="true" />
      {labels.needsYou}
    </span>
    {#if total > 1}
      <span class="chat-question-dock-progress" data-chat-question-progress>
        {labels.progress(position, total)}
      </span>
    {/if}
  </div>
  <fieldset class="chat-question-dock-fieldset">
    <legend id={legendId} class="chat-question-dock-legend" dir="auto">{labels.legend}</legend>
    {#if question.message !== undefined && question.message !== ''}
      <p id={questionId} class="chat-question-dock-question" dir="auto">{question.message}</p>
    {/if}
    <ChoiceGrid
      variant="card"
      columns={1}
      ariaLabelledby={question.message !== undefined && question.message !== ''
        ? questionId
        : legendId}
      bind:value={selected}
    >
      {#each choices as choice, index (index)}
        <ChoiceGridItem
          value={String(index)}
          disabled={question.busy}
          {...choice.description === undefined ? {} : { description: choice.description }}
        >
          <span class="chat-question-dock-choice">
            <span class="chat-question-dock-choice-label" dir="auto">{choice.label}</span>
            <kbd class="chat-question-dock-key" aria-hidden="true">{index + 1}</kbd>
          </span>
        </ChoiceGridItem>
      {/each}
      {#if allowsOther}
        <ChoiceGridItem value={OTHER_CHOICE} disabled={question.busy}>
          <span class="chat-question-dock-choice">
            <span class="chat-question-dock-choice-label" dir="auto">{labels.somethingElse}</span>
            <kbd class="chat-question-dock-key" aria-hidden="true">{choices.length + 1}</kbd>
          </span>
        </ChoiceGridItem>
      {/if}
    </ChoiceGrid>
    {#if pickingOther}
      <Input
        id={`${id}-other`}
        label={labels.ownAnswer}
        labelVisible={false}
        placeholder={labels.ownAnswerPlaceholder}
        bind:value={text}
        disabled={question.busy}
      />
    {/if}
  </fieldset>
  {#if errorText !== ''}
    <p id={errorId} class="chat-question-dock-error" role="alert">{errorText}</p>
  {:else if question.failed}
    <p id={errorId} class="chat-question-dock-error" role="alert">{labels.failed}</p>
  {/if}
  {#if !ready}
    <p id={hintId} class="chat-question-dock-hint" dir="auto">{reason}</p>
  {/if}
  <div class="chat-question-dock-actions">
    <Button type="button" variant="secondary" disabled={question.busy} onclick={onReply}>
      {labels.replyInChat}
    </Button>
    <Button
      type="submit"
      variant="primary"
      disabled={!ready || question.busy}
      aria-describedby={ready ? undefined : hintId}
    >
      {labels.answer}
    </Button>
  </div>
</form>

<style>
  .chat-question-dock {
    /* Radios at least 52 px tall: the card variant's own minimum, set once for the whole dock. */
    --_cinder-choice-card-min-block-size: 3.25rem;

    display: grid;
    gap: var(--cinder-space-3);
    inline-size: 100%;
    min-inline-size: 0;
    padding: var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface-raised, var(--cinder-surface));
  }

  .chat-question-dock-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  /* The step's warning: the run is waiting on the person, so it is named and not left to colour. */
  .chat-question-dock-needs {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1-5, 0.375rem);
    padding: var(--cinder-space-0-5, 0.125rem) var(--cinder-space-2);
    border-radius: var(--cinder-radius-full);
    background: var(--cinder-status-warning-background);
    color: var(--cinder-status-warning-text);
    font-weight: var(--cinder-font-semibold);
  }

  .chat-question-dock-progress {
    color: var(--cinder-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .chat-question-dock-fieldset {
    display: grid;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .chat-question-dock-legend {
    margin-block-end: var(--cinder-space-1);
    padding: 0;
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  .chat-question-dock-question {
    margin: 0 0 var(--cinder-space-1);
    line-height: var(--cinder-leading-snug);
    font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));
    font-weight: var(--cinder-font-semibold);
    overflow-wrap: anywhere;
  }

  .chat-question-dock-choice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
    inline-size: 100%;
  }

  .chat-question-dock-choice-label {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .chat-question-dock-key {
    flex: none;
    min-inline-size: 1.5rem;
    padding: 0 var(--cinder-space-1-5, 0.375rem);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-sm);
    color: var(--cinder-text-muted);
    font-family: inherit;
    font-size: var(--cinder-text-xs);
    font-weight: var(--cinder-font-medium);
    text-align: center;
  }

  .chat-question-dock-hint {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  .chat-question-dock-error {
    margin: 0;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    background: var(--cinder-status-danger-background);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-status-danger-text);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  /* Secondary on the left, primary on the right; on a phone both fill the row as touch targets. */
  .chat-question-dock-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  @media (max-width: 479.98px), (any-pointer: coarse) {
    .chat-question-dock-actions :global(.cinder-button) {
      flex: 1 1 auto;
      min-block-size: var(--cinder-touch-target-min);
    }
  }
</style>
