<script lang="ts" module>
  import type { ChatQuestionDockLabels } from './question-dock-labels.ts';
  import type { DockedQuestionTarget } from './question-store.svelte.ts';

  export type ChatQuestionDockProps = {
    /** Stable prefix for the ids of the dock's parts. */
    id: string;
    /** The question to show: an open one, or one already answered, which shows its answer selected. */
    question: DockedQuestionTarget;
    /** Where this question falls among those asked together, counting from 1. */
    position: number;
    /**
     * How many questions were asked together. The progress and the previous and next buttons show
     * only when it is more than 1.
     */
    total: number;
    /** Called when the person chooses to reply in chat instead. */
    onReply: () => void;
    /** Called with `-1` for the previous question and `1` for the next; nothing is sent. */
    onNavigate?: ((direction: -1 | 1) => void) | undefined;
    /** The words, any of which the host can replace. */
    labels?: Partial<ChatQuestionDockLabels> | undefined;
  };
</script>

<script lang="ts">
  /**
   * A pending question that has choices, docked in place of the composer (COR-2278, row P3): a
   * warning that the run needs the person, a fieldset named for what the agent is asking, radio
   * cards with the keys 1, 2 and 3 for the choices, and Something else, which opens a field. Every
   * choice is shown. The answer is always explicit: a choice only selects, and Answer sends it.
   * Reply in chat (quiet, on the left) gives the composer back; Answer (primary, on the
   * right) stays off, with its reason in view, until there is something to send. The keys work only
   * while focus is inside the dock and never inside a field, so they cannot take over typing.
   *
   * With several questions asked together the header also reads `Question 2 of 4` and has a
   * previous and a next button. They only move between the questions: nothing is sent. A question
   * already answered shows its answer selected, and choosing another answer sends it again, the way
   * Change does in the transcript.
   */
  import {
    Button,
    ChevronLeft,
    ChevronRight,
    ChoiceGrid,
    ChoiceGridItem,
    CircleAlert,
    createLabelFit,
    Input,
    MessageSquare,
    scrollEdgeFade,
    Tooltip,
  } from '@lostgradient/cinder';
  import { tick, untrack } from 'svelte';

  import { DEFAULT_QUESTION_DOCK_LABELS, OTHER_CHOICE } from './question-dock-labels.ts';
  import { choicesOf, classifyQuestion, type QuestionChoice } from './question-kind.ts';

  let {
    id,
    question,
    position,
    total,
    onReply,
    onNavigate,
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
          { value: true, label: labels.yes },
          { value: false, label: labels.no },
        ]
      : choicesOf(question.schema),
  );
  const allowsOther = $derived(kind === 'choice-other');
  const choiceCount = $derived(choices.length + (allowsOther ? 1 : 0));

  // The reply button shows its words while the whole row fits on one line with them.
  const fitReply = createLabelFit({
    control: '.chat-question-dock-reply-tip',
    attribute: 'data-chat-reply-compact',
    ignore: '[hidden]',
  });

  let root = $state<HTMLFormElement | undefined>();
  let optionsScroll = $state<HTMLDivElement | undefined>();
  let selected = $state<string | null>(null);
  let text = $state('');

  const pickingOther = $derived(selected === OTHER_CHOICE);
  const sentAnswer = $derived(question.answer);
  // The run has moved on: the sent answer is shown read only, with one line saying it was sent.
  const locked = $derived(question.locked);

  /** The answer the chosen card stands for, or the person's own words. */
  function chosenValue(): unknown {
    if (selected === OTHER_CHOICE) return text.trim();
    const choice = selected === null ? undefined : choices[Number(selected)];
    return choice?.value;
  }

  function sameValue(first: unknown, second: unknown): boolean {
    return Object.is(first, second) || JSON.stringify(first) === JSON.stringify(second);
  }

  // An answered question has something to send only once the person chooses a different answer.
  const unchanged = $derived(
    sentAnswer !== undefined && selected !== null && sameValue(chosenValue(), sentAnswer.value),
  );
  const ready = $derived(selected !== null && (!pickingOther || text.trim() !== '') && !unchanged);
  const errorText = $derived(question.issues.map((issue) => issue.message).join(' '));

  const questionId = $derived(`${id}-question`);
  const legendId = $derived(`${id}-legend`);
  const errorId = $derived(`${id}-error`);
  const hasMessage = $derived(question.message !== undefined && question.message !== '');

  /** What a question shows selected when it opens: nothing, or the answer that was sent. */
  function openingSelection(): { selected: string | null; text: string } {
    const answer = question.answer;
    if (answer === undefined) return { selected: null, text: '' };
    const index = choices.findIndex((choice) => sameValue(choice.value, answer.value));
    if (index >= 0) return { selected: String(index), text: '' };
    if (allowsOther && typeof answer.value === 'string') {
      return { selected: OTHER_CHOICE, text: answer.value };
    }
    return { selected: null, text: '' };
  }

  // The dock stays mounted from one question of the round to the next, so focus can stay on the
  // button that was pressed; the choice starts again from what the new question has sent, if
  // anything. Only a change of question resets it, never typing or an answer being sent.
  let wasOther = false;
  let shownQuestion: string | undefined;
  $effect.pre(() => {
    const shown = question.toolCallId;
    if (shown === shownQuestion) return;
    shownQuestion = shown;
    const opening = untrack(openingSelection);
    selected = opening.selected;
    text = opening.text;
    wasOther = opening.selected === OTHER_CHOICE;
  });

  /** Moves to the previous or next question, and keeps focus on a button that is still on. */
  async function step(direction: -1 | 1): Promise<void> {
    onNavigate?.(direction);
    await tick();
    const pressed = root?.querySelector<HTMLButtonElement>(
      direction === -1 ? '[data-chat-question-previous]' : '[data-chat-question-next]',
    );
    if (pressed?.disabled !== true) return;
    root
      ?.querySelector<HTMLButtonElement>(
        direction === -1 ? '[data-chat-question-next]' : '[data-chat-question-previous]',
      )
      ?.focus();
  }

  function send(event: SubmitEvent): void {
    event.preventDefault();
    if (!ready || question.busy || locked) return;
    void question.submit(chosenValue());
  }

  /** Focuses the own-answer field once Something else has opened it. */
  async function focusOwnAnswer(): Promise<void> {
    await tick();
    const selectedRadio = optionsScroll?.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    );
    if (selectedRadio && optionsScroll) {
      const radioBox = selectedRadio.getBoundingClientRect();
      const viewportBox = optionsScroll.getBoundingClientRect();
      // It stops where the list's start fade ends (its scroll padding), not under the fade.
      const fade = Number.parseFloat(getComputedStyle(optionsScroll).scrollPaddingBlockStart);
      optionsScroll.scrollTop +=
        radioBox.top - viewportBox.top - (Number.isFinite(fade) ? fade : 0);
    }
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
    if (index >= choiceCount || question.busy || locked) return;
    event.preventDefault();
    const next = index < choices.length ? String(index) : OTHER_CHOICE;
    selected = next;
    if (next === OTHER_CHOICE) void focusOwnAnswer();
  }

  // Choosing Something else with the pointer or the arrow keys opens the field the same way.
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
  <!-- The tag comes first, so it is read before the question. With one question the tag and the
       question share a row when the question fits on one line beside it (the question at the
       leading end, the tag at the trailing end), and otherwise the tag takes the line above and the
       question the full width. With several, the row is the same, and the progress with its
       buttons is a row of its own above it, at the leading edge where the question starts: the
       muted words first and the previous and next buttons right after them. -->
  <div
    class="chat-question-dock-heading"
    data-chat-question-heading
    data-chat-question-several={total > 1 ? '' : undefined}
  >
    <span class="chat-question-dock-needs" data-chat-question-needs>
      <CircleAlert class="cinder-icon-sm" aria-hidden="true" />
      {labels.needsYou}
    </span>
    {#if total > 1}
      <div class="chat-question-dock-steps" data-chat-question-steps>
        <span class="chat-question-dock-progress" data-chat-question-progress>
          {labels.progress(position, total)}
        </span>
        <Tooltip text={labels.previous} placement="top" describe={false}>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            iconOnly
            label={labels.previous}
            data-chat-question-previous=""
            disabled={position <= 1 || question.busy}
            onclick={() => void step(-1)}
          >
            {#snippet leadingIcon()}<ChevronLeft aria-hidden="true" />{/snippet}
          </Button>
        </Tooltip>
        <Tooltip text={labels.next} placement="top" describe={false}>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            iconOnly
            label={labels.next}
            data-chat-question-next=""
            disabled={position >= total || question.busy}
            onclick={() => void step(1)}
          >
            {#snippet leadingIcon()}<ChevronRight aria-hidden="true" />{/snippet}
          </Button>
        </Tooltip>
      </div>
    {/if}
    {#if hasMessage}
      <p id={questionId} class="chat-question-dock-question" dir="auto">{question.message}</p>
    {/if}
  </div>
  <div class="chat-question-dock-body">
    <fieldset class="chat-question-dock-fieldset">
      <legend id={legendId} class="cinder-sr-only" dir="auto">{labels.legend}</legend>
      <div class="chat-question-dock-options">
        <div
          bind:this={optionsScroll}
          class="chat-question-dock-options-scroll"
          {@attach scrollEdgeFade('block')}
        >
          <ChoiceGrid
            variant="card"
            size="sm"
            columns={1}
            ariaLabelledby={hasMessage ? questionId : legendId}
            bind:value={selected}
          >
            {#each choices as choice, index (index)}
              <ChoiceGridItem
                value={String(index)}
                disabled={question.busy || locked}
                {...choice.description === undefined ? {} : { description: choice.description }}
              >
                <span class="chat-question-dock-choice">
                  <span class="chat-question-dock-choice-label" dir="auto">{choice.label}</span>
                  <kbd class="chat-question-dock-key" aria-hidden="true">{index + 1}</kbd>
                </span>
              </ChoiceGridItem>
            {/each}
            {#if allowsOther}
              <ChoiceGridItem value={OTHER_CHOICE} disabled={question.busy || locked}>
                <span class="chat-question-dock-choice">
                  <span class="chat-question-dock-choice-label" dir="auto"
                    >{labels.somethingElse}</span
                  >
                  <kbd class="chat-question-dock-key" aria-hidden="true">{choices.length + 1}</kbd>
                </span>
              </ChoiceGridItem>
            {/if}
          </ChoiceGrid>
        </div>
      </div>
      <div class="chat-question-dock-completion">
        {#if pickingOther}
          <Input
            id={`${id}-other`}
            label={labels.ownAnswer}
            labelVisible={false}
            placeholder={labels.ownAnswerPlaceholder}
            bind:value={text}
            disabled={question.busy || locked}
          />
        {/if}
        {#if locked}
          <p class="chat-question-dock-sent" data-chat-question-sent>{labels.sent}</p>
        {/if}
        {#if errorText !== ''}
          <p id={errorId} class="chat-question-dock-error" role="alert">{errorText}</p>
        {:else if question.failed}
          <p id={errorId} class="chat-question-dock-error" role="alert">{labels.failed}</p>
        {/if}
      </div>
    </fieldset>
  </div>
  <div class="chat-question-dock-actions" {@attach fitReply}>
    <!-- A quiet button with its glyph and its words. Only when the row cannot hold the words does
         the row's fit mark the wrapper compact, and the icon-only button with the secondary outline
         takes the words' place (the other is not displayed, so one control is ever reachable). -->
    <Tooltip
      text={labels.replyInChat}
      placement="top"
      describe={false}
      class="chat-question-dock-reply-tip"
    >
      <Button
        type="button"
        class="chat-question-dock-reply-words"
        size="sm"
        variant="ghost"
        label={labels.replyInChat}
        disabled={question.busy}
        onclick={onReply}
      >
        {#snippet leadingIcon()}<MessageSquare aria-hidden="true" />{/snippet}
      </Button>
      <Button
        type="button"
        class="chat-question-dock-reply-icon"
        size="sm"
        variant="secondary"
        iconOnly
        label={labels.replyInChat}
        disabled={question.busy}
        onclick={onReply}
      >
        {#snippet leadingIcon()}<MessageSquare aria-hidden="true" />{/snippet}
      </Button>
    </Tooltip>
    <Button type="submit" variant="primary" disabled={!ready || question.busy || locked}>
      {labels.answer}
    </Button>
  </div>
</form>

<style>
  /* The panel is as tall as its content up to about 80% of the viewport. Past that only the list of
     choices scrolls: the header, the question, the own-answer field and the actions stay in view. */
  .chat-question-dock {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    box-sizing: border-box;
    gap: var(--cinder-space-3);
    inline-size: 100%;
    min-inline-size: 0;
    padding: var(--cinder-space-3);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface-raised, var(--cinder-surface));
    max-block-size: min(100%, 80dvh);
  }

  /* One question: a wrapping row whose lines stack upwards. The question comes first on the row
   * and grows, and the tag follows it, so a question that fits on one line beside the tag leaves the
   * tag at the trailing end. A question that does not fit goes alone on its line, and the tag,
   * wrapped onto the next line, is drawn above it (the lines stack from the bottom) at the leading
   * end, never squeezed or wrapped. The tag stays first in the document, so it is read first. */
  .chat-question-dock-heading {
    display: flex;
    flex-wrap: wrap-reverse;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    min-inline-size: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  .chat-question-dock-heading > .chat-question-dock-needs {
    order: 1;
    flex: none;
    white-space: nowrap;
  }

  .chat-question-dock-heading > .chat-question-dock-question {
    order: 0;
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  /* Several questions use the same row, and the pager is a row of its own above it: the muted
   * words "Question 2 of 4" at the leading edge, where the question starts, with the previous and
   * next buttons directly after them. It is the last item and asks for the whole line, so it is
   * the line the others wrap above, and never shares a line with the tag or the question. */
  .chat-question-dock-steps {
    display: flex;
    flex: 1 0 100%;
    align-items: center;
    justify-content: flex-start;
    gap: var(--cinder-space-1);
    order: 2;
  }

  /* The chevrons point the way the questions run, so right-to-left mirrors them. */
  .chat-question-dock-steps:dir(rtl) :global(svg) {
    transform: scaleX(-1);
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
    font-size: var(--cinder-text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chat-question-dock-fieldset {
    display: grid;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  /* The body does not scroll: the list of choices does, so the question above it and the field
     below it stay where they are. */
  .chat-question-dock-body {
    min-block-size: 0;
  }

  .chat-question-dock-fieldset {
    grid-template-areas:
      'options'
      'completion';
    grid-template-rows: minmax(0, 1fr) auto;
    block-size: 100%;
    min-block-size: 0;
  }

  .chat-question-dock-options {
    grid-area: options;
    display: flex;
    flex-direction: column;
    min-block-size: 0;
  }

  /* `overflow-y: auto` clips inline too: the padding keeps a card's focus ring (its width plus the
     gap) inside the scroller, and the matching negative margin leaves the text column alone. The
     last visible row fades into the list's edge while more choices lie past it (Cinder's
     `scrollEdgeFade`), with no caption. */
  .chat-question-dock-options-scroll {
    --_dock-ring-room: calc(var(--cinder-ring-width, 2px) + 2px);
    flex: 0 1 auto;
    min-block-size: 0;
    padding: var(--_dock-ring-room);
    margin: calc(var(--_dock-ring-room) * -1);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .chat-question-dock-completion {
    grid-area: completion;
    display: grid;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    padding: var(--cinder-space-2) 0 var(--cinder-space-1);
  }

  .chat-question-dock-body :global(.cinder-choice-grid-item[data-cinder-variant='card']) {
    padding-block: var(--cinder-space-2);
    gap: var(--cinder-space-2);
  }

  .chat-question-dock-body
    :global(
      .cinder-choice-grid-item[data-cinder-variant='card'] .cinder-choice-grid-item__description
    ) {
    flex: 1 1 auto;
    line-height: var(--cinder-leading-tight, 1.25);
  }

  /* A description follows its title on the title's line when the whole of it fits, else it wraps below. */
  .chat-question-dock-body
    :global(.cinder-choice-grid-item[data-cinder-variant='card'] .cinder-choice-grid-item__card) {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--cinder-space-2);
    row-gap: 0;
  }

  /* The question and its choices read at 14px; the question stays semibold. */
  .chat-question-dock-question {
    margin: 0;
    line-height: var(--cinder-leading-snug);
    font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));
    font-weight: var(--cinder-font-semibold);
    overflow-wrap: anywhere;
  }

  .chat-question-dock-choice {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));
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

  @media (any-pointer: coarse) {
    .chat-question-dock-key {
      display: none;
    }
  }

  /* One muted line, at the notice size: the answer was sent and is no longer open to change. */
  .chat-question-dock-sent {
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

  /* "Reply in chat" stays at the leading end and Answer, the primary, ends at the trailing content
   * edge, also when the row wraps; both keep their compact width. The quiet button is pulled back by
   * its own inline padding so its glyph starts on the panel's content edge; its 44px hit area comes
   * from the Button's pseudo-element, which takes no layout. */
  .chat-question-dock-actions :global(.chat-question-dock-reply-tip) {
    flex: none;
    margin-inline-end: auto;
  }

  /* The words never squeeze, clip or wrap: they are one line at their own width, or the icon. */
  .chat-question-dock-actions :global(.chat-question-dock-reply-words) {
    flex: none;
    inline-size: auto;
    max-inline-size: none;
    min-inline-size: max-content;
    margin-inline-start: calc(-1 * var(--cinder-button-padding-x-sm));
    white-space: nowrap;
  }

  .chat-question-dock-actions :global(.chat-question-dock-reply-words .cinder-button__label) {
    flex: none;
    max-inline-size: none;
    min-inline-size: max-content;
    overflow: visible;
    text-overflow: clip;
    white-space: nowrap;
  }

  .chat-question-dock-actions :global(.chat-question-dock-reply-icon) {
    display: none;
  }

  /* The row cannot hold the words: the icon-only button with the secondary outline replaces them. */
  .chat-question-dock-actions :global([data-chat-reply-compact] .chat-question-dock-reply-words) {
    display: none;
  }

  .chat-question-dock-actions :global([data-chat-reply-compact] .chat-question-dock-reply-icon) {
    display: inline-flex;
  }

  .chat-question-dock-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    padding-block-start: var(--cinder-space-2);
    border-block-start: 1px solid var(--cinder-border-muted);
    background: var(--cinder-surface-raised, var(--cinder-surface));
  }

  @media (max-width: 479.98px), (any-pointer: coarse) {
    .chat-question-dock {
      block-size: auto;
      max-block-size: min(80dvh, calc(100dvh - 2 * var(--cinder-space-3)));
      gap: var(--cinder-space-2);
    }

    .chat-question-dock-completion {
      padding-block-start: 0;
    }

    .chat-question-dock-actions :global(.cinder-button) {
      flex: 0 0 auto;
    }
  }

  .chat-question-dock-actions > :global(button[type='submit']) {
    margin-inline-start: auto;
  }
</style>
