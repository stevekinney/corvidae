<script lang="ts" module>
  import type { ToolInputMessagePart } from '../../utilities/types.ts';
  import type { ChatLabels } from '../../chat-labels.ts';
  import { resolveChatLabels } from '../../chat-labels.ts';

  export type ToolInputPartProps = {
    /** The tool-input render part. */
    part: ToolInputMessagePart;
    /** Called with the schema-valid value when the user submits the form. */
    onInputSubmit?: ((toolCallId: string, value: unknown) => void | Promise<void>) | undefined;
    labels?: Partial<ChatLabels> | undefined;
  };
</script>

<script lang="ts">
  import { CircleAlert, validateSchemaFormValue } from '@lostgradient/cinder';
  import ChatQuestion from '../../question/chat-question.svelte';
  import { holdsSecret, issuesOfRejection, recordAnswer } from '../../question/question-answer.ts';
  import type { ChatQuestionIssue } from '../../question/question-answer.ts';
  import { classifyQuestion } from '../../question/question-kind.ts';
  import { QuestionStore, useQuestionStore } from '../../question/question-store.svelte.ts';

  let { part, onInputSubmit, labels }: ToolInputPartProps = $props();

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
  // A question that has choices is drawn in the dock in place of the composer, when the host asks
  // for `questionPlacement="docked"`, until the person replies in chat instead. Its row then holds
  // only the question; once it is answered the row is the receipt, as for any question.
  // Whether the question belongs to the dock's round: open, or answered here, so the dock can step
  // back to it. Before the run moves on the answer can be changed the way Change does; after, it is
  // shown read only (the part is resolved), so the count and the way back do not shrink under the
  // person while other questions of the round are still open.
  const dockEligible = $derived(
    sharedStore !== undefined &&
      sharedStore.placement === 'docked' &&
      (kind === 'choice' || kind === 'choice-other' || kind === 'boolean') &&
      (!resolved || answer !== undefined) &&
      onInputSubmit !== undefined &&
      !sharedStore.isDockDismissed(part.toolCallId),
  );
  const docked = $derived(dockEligible && !answered && !changing);
  const heading = $derived(
    part.message !== undefined && part.message !== ''
      ? part.message
      : resolveChatLabels(labels).inputRequestedBy(part.toolName),
  );

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

  // An open free-text question, or a choice that takes the person's own answer, is the one the
  // composer answers, when the host says so.
  $effect(() => {
    if (sharedStore === undefined || !answerInComposer) return;
    if (kind !== 'text' && kind !== 'choice-other') return;
    if (resolved || answered || docked || onInputSubmit === undefined) return;
    return sharedStore.registerComposerTarget({
      toolCallId: part.toolCallId,
      kind,
      submit: (text) => submitAnswer(text),
    });
  });

  // The dock reads the question through getters, so it stays current as the part is derived again
  // (a new `part` object with the same content) and as the answer is sent, refused or fails. The
  // effect depends only on whether the question belongs to the round and on its call id, so a new
  // part, or an answer, never unregisters and registers it again, which would move it behind the
  // questions asked after it.
  const toolCallId = $derived(part.toolCallId);
  $effect(() => {
    if (!dockEligible || sharedStore === undefined) return;
    const shared = sharedStore;
    return shared.registerDockedQuestion({
      toolCallId,
      get answer() {
        return answer;
      },
      get locked() {
        return resolved;
      },
      get schema() {
        return part.schema;
      },
      get message() {
        return part.message;
      },
      // A sent answer, a new one or a changed one, takes the dock back to the first open question.
      submit: async (value) => {
        const sent = await submitAnswer(value);
        if (sent) shared.viewDock(undefined);
        return sent;
      },
      get busy() {
        return busy;
      },
      get failed() {
        return failed;
      },
      get issues() {
        return issues;
      },
    });
  });
</script>

{#if !docked}
  <!-- The question is the one visible heading and names the region; the tool's identifier is not
       said here, because the expanded tool activity already carries it. A request with no question
       falls back to naming the tool. Pending docked questions render only in the shared dock, so
       the transcript never repeats the active or queued prompt. -->
  <section class="chat-tool-input" aria-labelledby={headingId} data-cinder-tool-input>
    <!-- The same two parts as the dock's heading, under the same rule: the tag first in the
         document, drawn beside the question when the question fits on one line there and above it
         when it does not. -->
    <div class="chat-tool-input-title">
      {#if !answered && !resolved && onInputSubmit !== undefined}
        <span class="chat-tool-input-needs" data-chat-question-needs>
          <CircleAlert class="cinder-icon-sm" aria-hidden="true" />
          {resolveChatLabels(labels).needsYou}
        </span>
      {/if}
      <h4 id={headingId} class="chat-tool-input-heading" dir="auto">{heading}</h4>
    </div>
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
        {labels}
      />
    {/if}
  </section>
{/if}

<style>
  .chat-tool-input {
    display: grid;
    gap: var(--cinder-space-2);
    inline-size: 100%;
  }

  /* A wrapping row whose lines stack upwards: the question first and growing, the tag after it, so
   * a question that fits on one line beside the tag leaves the tag at the trailing end, and one
   * that does not takes its own line with the tag, wrapped, drawn above it at the leading end. */
  .chat-tool-input-title {
    display: flex;
    flex-wrap: wrap-reverse;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    min-inline-size: 0;
  }

  .chat-tool-input-title > .chat-tool-input-needs {
    order: 1;
    flex: none;
    white-space: nowrap;
  }

  .chat-tool-input-title > .chat-tool-input-heading {
    order: 0;
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .chat-tool-input-needs {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1-5, 0.375rem);
    padding: var(--cinder-space-0-5, 0.125rem) var(--cinder-space-2);
    border-radius: var(--cinder-radius-full);
    background: var(--cinder-status-warning-background);
    color: var(--cinder-status-warning-text);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-semibold);
  }

  /* The question: the one heading of the request, at the docked question's 14px and weight. */
  .chat-tool-input-heading {
    margin: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-semibold);
    overflow-wrap: anywhere;
  }
</style>
