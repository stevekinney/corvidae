<script lang="ts">
  /**
   * One question an agent asked, with its one text field and Send. What the agent does with the
   * answer is said once, under the field. Shared by `/reviews` and a run's page.
   */
  import { Alert, Button, Input } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import IdentifierText from '../identifier-text.svelte';

  interface QuestionDecisionProps {
    id: string;
    question: string;
    sending: boolean;
    failure?: string | undefined;
    onSend: (answer: string) => void | Promise<void>;
  }

  let { id, question, sending, failure, onSend }: QuestionDecisionProps = $props();
  let answer = $state('');

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = answer.trim();
    if (text === '' || sending) return;
    await onSend(text);
  }
</script>

<form class="ib-decision" data-kind="question" onsubmit={submit}>
  <p class="ib-decision__question" id={`${id}-question`}><IdentifierText text={question} /></p>
  <div class="ib-decision__answer">
    <Input
      id={`${id}-answer`}
      label={REVIEWS_COPY.answerLabel}
      labelVisible={false}
      placeholder={REVIEWS_COPY.answerLabel}
      bind:value={answer}
      disabled={sending}
    />
    <Button
      type="submit"
      variant="primary"
      size="lg"
      label={REVIEWS_COPY.sendAnswer}
      loading={sending}
      disabled={answer.trim() === '' || sending}
    />
  </div>
  <p class="ib-decision__hint">{REVIEWS_COPY.answerHint}</p>
  {#if failure !== undefined}
    <Alert variant="danger"><p class="ib-decision__failure">{failure}</p></Alert>
  {/if}
</form>
