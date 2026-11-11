<script lang="ts">
  /**
   * One question an agent asked, open: the question, the line that says who asked, and the answer in
   * the shape the question wants (`ChatQuestion`, the chat's own: choices as full-width options with
   * Something else…, a form for a structured answer, a text box when there is no schema). A choice
   * is also picked with the number keys (`choice-buttons.ts`). A question that was answered shows
   * that it was, never the answer.
   *
   * A choice is sent as it is picked and held for five seconds first, with Undo in one line inside
   * the question (`undoMilliseconds`). A structured answer (a form) is committed by "Send answer" in
   * the footer, beside what the agent does next: picking a value in the form sends nothing.
   */
  import { Button } from '@lostgradient/cinder';
  import { ChatQuestion, classifyQuestion } from '@lostgradient/chat';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import { answerUndoMilliseconds } from '../../lib/answer-undo.ts';
  import { uploadAsset } from '../../lib/bureau-assets.ts';
  import type { BureauHumanWait } from '../../lib/bureau-reviews.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { choiceButtons } from './choice-buttons.ts';
  import type { ReviewOutcome } from './review-outcome.ts';
  import ReviewResolution from './review-resolution.svelte';
  import ReviewSource from './review-source.svelte';

  interface QuestionPaneProps {
    readonly review: BureauHumanWait;
    /** Whether an answer is being sent. */
    readonly answering: boolean;
    /** What became of the last answer, when it was not simply taken. */
    readonly outcome: ReviewOutcome | undefined;
    readonly onAnswer: (answer: unknown) => void;
  }

  let { review, answering, outcome, onAnswer }: QuestionPaneProps = $props();

  const waiting = $derived(review.status === 'pending');
  /** What a question that declares no schema takes: free text. */
  const FREE_TEXT_SCHEMA = { type: 'string', title: REVIEWS_COPY.answerLabel } as const;
  const schema = $derived<Readonly<Record<string, unknown>>>(
    review.inputSchema ?? FREE_TEXT_SCHEMA,
  );

  /** Whether the answer is a form, which the footer's "Send answer" commits. */
  const structured = $derived(classifyQuestion(schema) === 'fields');
  /** Whether a picked answer is in its Undo window, which the footer must not send over. */
  let held = $state(false);

  let answerElement = $state<HTMLElement | undefined>();
  let pickable = $state(false);
  // Whether the question draws choices to pick, which the drawn buttons say. It is read again for
  // each review, because the pane stays mounted while the open review changes.
  $effect(() => {
    void review.id;
    pickable = choiceButtons(answerElement).length > 0;
  });
</script>

<div class="ib-review-pane" data-kind="human-wait" data-review={review.id}>
  <div class="ib-review-pane__content">
    <p class="ib-review-pane__eyebrow">{REVIEWS_COPY.questionEyebrow}</p>
    <h2 class="ib-review-pane__question" id={`review-${review.id}-question`}>
      <IdentifierText
        text={review.prompt ?? REVIEWS_COPY.questionFallback}
        identifiers={review.agentName === undefined ? [] : [review.agentName]}
      />
    </h2>
    <ReviewSource {review} {waiting} />
    {#if waiting}
      <div class="ib-review-pane__answer" bind:this={answerElement} data-question-answer-region>
        <ChatQuestion
          {...{ 'data-changes': true }}
          id={`review-${review.id}`}
          {schema}
          answerInComposer={false}
          busy={answering}
          issues={outcome?.issues ?? []}
          failed={outcome !== undefined && outcome.issues === undefined}
          uploadFile={async (file, signal) => (await uploadAsset(file, { signal })).assetId}
          undoMilliseconds={answerUndoMilliseconds()}
          externalSubmit={structured}
          onHoldChange={(isHeld) => (held = isHeld)}
          onSubmit={onAnswer}
        />
      </div>
      {#if outcome !== undefined && outcome.issues === undefined && outcome.message !== ''}
        <p class="ib-review-pane__note" role="alert">{outcome.message}</p>
      {/if}
      {#if pickable}
        <p class="ib-review-pane__note ib-review-pane__hint">{REVIEWS_COPY.pickHint}</p>
      {/if}
    {:else}
      <ReviewResolution {review} />
    {/if}
  </div>
  {#if waiting}
    <div class="ib-review-pane__footer">
      <p class="ib-review-pane__footer-note">{REVIEWS_COPY.answerHint}</p>
      {#if structured}
        <Button
          type="submit"
          form={`review-${review.id}-form`}
          variant="primary"
          disabled={answering || held}
          label={REVIEWS_COPY.sendAnswer}
        />
      {/if}
    </div>
  {/if}
</div>
