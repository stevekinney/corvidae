<script lang="ts" module>
  import type { ToolInputMessagePart } from '../../utilities/types.ts';

  export type ToolInputPartProps = {
    /** The tool-input render part. */
    part: ToolInputMessagePart;
    /** Called with the schema-valid value when the user submits the form. */
    onInputSubmit?: ((toolCallId: string, value: unknown) => void | Promise<void>) | undefined;
  };
</script>

<script lang="ts">
  import { validateSchemaFormValue } from '@lostgradient/cinder';
  import ChatQuestion from '../../question/chat-question.svelte';
  import { holdsSecret, issuesOfRejection, recordAnswer } from '../../question/question-answer.ts';
  import type { ChatQuestionIssue } from '../../question/question-answer.ts';
  import { classifyQuestion } from '../../question/question-kind.ts';
  import { QuestionStore, useQuestionStore } from '../../question/question-store.svelte.ts';

  let { part, onInputSubmit }: ToolInputPartProps = $props();

  const headingId = $props.id();
  const sharedStore = useQuestionStore();
  // A question outside a Chat (a reviews inbox, a test) keeps its answers here.
  const ownStore = new QuestionStore(() => false);
  const store = $derived(sharedStore ?? ownStore);
  const answer = $derived(store.answers.get(part.toolCallId));

  let changing = $state(false);
  let busy = $state(false);
  let failed = $state(false);
  let issues = $state<readonly ChatQuestionIssue[]>([]);

  // Once the run has moved on there is nothing left to change or answer.
  const resolved = $derived(part.resolved === true);
  const answered = $derived(answer !== undefined && (!changing || resolved));
  const kind = $derived(classifyQuestion(part.schema));
  const answerInComposer = $derived(sharedStore?.answerInComposer ?? false);

  // Sends an answer. Resolves true when the host accepted it. A refusal that names fields keeps
  // the question open with the issues on those fields; any other rejection reads as "try again".
  async function submitAnswer(value: unknown): Promise<boolean> {
    if (onInputSubmit === undefined || busy || resolved) return false;
    busy = true;
    failed = false;
    issues = [];
    const generation = store.generation;
    try {
      // The host is called only with an answer that meets the whole schema, whichever control
      // gave it, so the composer and the specialised controls are held to what SchemaForm is.
      const checked = await validateSchemaFormValue(part.schema, value);
      if (!checked.valid) {
        // A validator's message can quote the value, which a secret must never be.
        issues = holdsSecret(part.schema)
          ? checked.issues.map((issue) => ({ ...issue, message: 'This answer is not valid.' }))
          : checked.issues;
        return false;
      }
      await onInputSubmit(part.toolCallId, value);
      // A different conversation has taken the store while the host was answering.
      if (store.generation !== generation) return false;
      store.answers.set(
        part.toolCallId,
        recordAnswer({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          message: part.message,
          schema: part.schema,
          value,
        }),
      );
      changing = false;
      return true;
    } catch (error) {
      const found = issuesOfRejection(error);
      if (found === undefined) failed = true;
      else issues = found;
      return false;
    } finally {
      busy = false;
    }
  }

  // An open free-text question is the one the composer answers, when the host says so.
  $effect(() => {
    if (sharedStore === undefined || !answerInComposer || kind !== 'text') return;
    if (resolved || answered || onInputSubmit === undefined) return;
    return sharedStore.registerComposerTarget({
      toolCallId: part.toolCallId,
      submit: (text) => submitAnswer(text),
    });
  });
</script>

<section class="chat-tool-input" aria-labelledby={headingId} data-cinder-tool-input>
  <h4 id={headingId} class="chat-tool-input-heading">Input requested by {part.toolName}</h4>
  {#if part.message}
    <p class="chat-tool-input-message">{part.message}</p>
  {/if}
  {#if answered || onInputSubmit !== undefined}
    <ChatQuestion
      schema={part.schema}
      id={headingId}
      answer={answered ? answer : undefined}
      initialValue={changing ? answer?.value : undefined}
      {answerInComposer}
      {busy}
      {issues}
      {failed}
      uploadFile={store.uploadFile}
      maxFileSize={store.maxFileSize}
      onSubmit={(value) => void submitAnswer(value)}
      onChange={onInputSubmit === undefined || resolved ? undefined : () => (changing = true)}
    />
  {/if}
</section>

<style>
  .chat-tool-input {
    display: grid;
    gap: var(--cinder-space-2);
    inline-size: 100%;
  }

  .chat-tool-input-heading {
    margin: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-semibold);
  }

  .chat-tool-input-message {
    margin: 0;
  }
</style>
