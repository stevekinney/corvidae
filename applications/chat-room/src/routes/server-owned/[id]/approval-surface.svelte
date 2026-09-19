<script lang="ts">
  import { untrack } from 'svelte';

  import { toBannerFailure, type BannerFailure } from '../../../lib/chat-failure.ts';

  let {
    id,
    streaming,
    question = null,
    failure = $bindable<BannerFailure | null>(),
    failureMessage,
  }: {
    id: string;
    streaming: boolean;
    /**
     * The question this turn's stream has raised, read off the response body
     * by the surface above.
     *
     * THE ONLY PATH by which a question is discovered. Until it existed, this
     * component asked `GET …/elicitation` every 250ms, because nothing on the
     * response body said a question had been raised — so a client whose reads
     * could not get through had a run parked on a question it would never
     * show, and every other client learned about one up to a poll interval
     * late. The side channel remains for answering and for the two
     * demand-driven reads below; it no longer discovers anything.
     */
    question?: StreamedQuestion | null;
    failure?: BannerFailure | null;
    failureMessage: (response: Response) => Promise<string>;
  } = $props();

  type StreamedQuestion = { requestId: string; callId: string; message: string };

  /**
   * `toolName` and `arguments` are OPTIONAL, and that is the shape of the two
   * sources rather than laxity.
   *
   * The frame carries the question's identity and its sentence — everything
   * needed to show it and to answer it. It has no field for the model's
   * proposed arguments, which are read from `GET …/elicitation` as a second
   * step. So a question always renders, and the disclosure of what is being
   * approved appears once that read lands.
   *
   * The GET's own body is still required to carry all four: `isPendingApproval`
   * below is unchanged and strict, because a response that omits them is
   * malformed. A frame-derived pending is CONSTRUCTED here rather than parsed,
   * and never goes through that guard.
   */
  type PendingApproval = {
    toolName?: string;
    callId: string;
    message: string;
    arguments?: Record<string, unknown>;
  };

  let pending = $state<PendingApproval | null>(null);
  let deciding = $state(false);

  let approvalQuestion = $state<HTMLElement | null>(null);

  let approvalSection = $state<HTMLElement | null>(null);

  let readGeneration = 0;

  let answerEpoch = 0;

  let readController: AbortController | null = null;
  let decisionController: AbortController | null = null;
  let decisionAttempt = 0;

  function clearReadFailure(): void {
    if (readFailure !== null && failure === readFailure) failure = null;
    readFailure = null;
  }

  let readFailure: BannerFailure | null = null;

  let decideFailure: BannerFailure | null = null;

  function propertyOf(value: object, key: string): unknown {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  }

  function isPendingBody(value: unknown): value is { pending: PendingApproval | null } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const pendingValue = propertyOf(value, 'pending');
    return pendingValue === null || isPendingApproval(pendingValue);
  }

  function isPendingApproval(value: unknown): value is PendingApproval {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proposedArguments = propertyOf(value, 'arguments');
    return (
      typeof propertyOf(value, 'toolName') === 'string' &&
      typeof propertyOf(value, 'callId') === 'string' &&
      typeof propertyOf(value, 'message') === 'string' &&
      typeof proposedArguments === 'object' &&
      proposedArguments !== null &&
      !Array.isArray(proposedArguments)
    );
  }

  /**
   * Shows a question the stream raised, then reads its proposed arguments.
   *
   * The ORDER is the point: the sentence renders from the frame immediately,
   * and the disclosure fills in afterwards if the read succeeds. A component
   * that waited for the read before showing anything would still have the side
   * channel on its critical path, just less visibly.
   */
  function adoptStreamedQuestion(asked: StreamedQuestion): void {
    applyPending({ callId: asked.callId, message: asked.message });
    void readPendingApproval(readGeneration, readController?.signal);
  }

  function applyPending(nextPending: PendingApproval | null): void {
    const answeredOrChanged = nextPending === null || nextPending.callId !== pending?.callId;
    if (answeredOrChanged) {
      invalidateDecision();
      handOffFocusFromApproval(nextPending);
    }
    pending = nextPending;
    clearReadFailure();
  }

  function installDecisionFailure(reported: BannerFailure): void {
    decideFailure = reported;
    failure = reported;
  }

  function clearDecisionFailure(): void {
    if (decideFailure !== null && failure === decideFailure) failure = null;
    decideFailure = null;
  }

  function installReadFailure(reported: BannerFailure): void {
    // A failed READ is secondary context: it means the proposed arguments or a
    // re-read did not arrive, never that the decision failed. Preserve a
    // decision or controller failure over it, and let `clearReadFailure`
    // remove only a banner this path actually owns.
    if (failure !== null && failure !== readFailure) return;
    readFailure = reported;
    failure = reported;
  }

  function invalidateDecision(): void {
    decisionAttempt += 1;
    decisionController?.abort();
    decisionController = null;
    deciding = false;
    if (decideFailure !== null && failure === decideFailure) failure = null;
    decideFailure = null;
  }

  async function applyPendingResponse(response: Response, stale: () => boolean): Promise<void> {
    if (!response.ok) {
      const message = await failureMessage(response);
      if (!stale()) installReadFailure(toBannerFailure(new Error(message)));
      return;
    }
    const body: unknown = await response.json();
    if (stale()) return;
    if (!isPendingBody(body)) {
      installReadFailure(toBannerFailure(new Error('Approval response was invalid.')));
      return;
    }
    hydratePending(body.pending);
  }

  /**
   * Fills in the detail for the question already on screen — and NOTHING else.
   *
   * THE READ DOES NOT DECIDE WHETHER A QUESTION EXISTS. That authority belongs
   * to the stream: `elicitation.requested` raises one and `elicitation.resolved`
   * takes it away. This read exists for one reason, which is that the frame has
   * no field for the model's proposed arguments.
   *
   * So a body naming a DIFFERENT call, or no call at all, is ignored rather
   * than applied. It is not news — it is the side channel's view of a moment
   * that has already moved, and the frame that describes that same moment is
   * either already here or on its way. Applying it was a real defect: a read
   * issued the instant a question was raised can answer `null` if the server
   * settles it in between, and letting that clear the prompt put removal back
   * in the hands of the channel this change exists to take it away from.
   */
  function hydratePending(readPending: PendingApproval | null): void {
    if (readPending === null || pending === null) return;
    if (readPending.callId !== pending.callId) return;
    pending = {
      ...pending,
      ...(readPending.toolName === undefined ? {} : { toolName: readPending.toolName }),
      ...(readPending.arguments === undefined ? {} : { arguments: readPending.arguments }),
    };
    clearReadFailure();
  }

  async function handleDecisionResponse(
    response: Response,
    stale: () => boolean,
  ): Promise<boolean> {
    if (stale()) return true;
    if (response.status === 409) {
      answerEpoch += 1;
      await readPendingApproval(readGeneration, readController?.signal);
      return true;
    }
    if (!response.ok) {
      const message = await failureMessage(response);
      if (!stale()) installDecisionFailure(toBannerFailure(new Error(message)));
      return true;
    }
    return false;
  }

  function completeDecisionSuccess(): void {
    handOffFocusFromApproval(null);
    pending = null;
    answerEpoch += 1;
    clearDecisionFailure();
  }

  async function readPendingApproval(generation: number, signal?: AbortSignal): Promise<void> {
    const epoch = answerEpoch;
    const stale = (): boolean => generation !== readGeneration || epoch !== answerEpoch;
    try {
      const response = await fetch(
        `/api/server-owned/conversations/${id}/elicitation`,
        signal === undefined ? {} : { signal },
      );
      if (stale()) return;

      await applyPendingResponse(response, stale);
    } catch (cause) {
      // An ABORT is this component's own cleanup, not a failure to report.
      if (signal?.aborted === true) return;
      if (stale()) return;
      const reported = toBannerFailure(cause);
      installReadFailure(reported);
    }
  }

  function chatTranscript(): HTMLElement | null {
    return (
      approvalSection?.parentElement?.querySelector<HTMLElement>(
        '[data-testid="server-owned-chat"] [role="log"]',
      ) ?? null
    );
  }

  function focusChatTranscript(): void {
    chatTranscript()?.focus();
  }

  /**
   * Whether the transcript holds focus because THIS component put it there.
   *
   * Load-bearing for a replacement. A question being replaced used to be one
   * event — the poll returned a different `callId` — so focus was still on
   * Approve when the new question arrived and could be moved straight to it.
   * On the stream it is two: `elicitation.resolved` for the old question, then
   * `elicitation.requested` for the new one. The first hands focus to the
   * transcript, and by the time the second arrives focus is no longer inside
   * the approval region, so the handoff below would decline to move it and
   * leave the person in the transcript in the middle of a decision.
   *
   * Remembering that the transcript's focus is ours is what lets the
   * replacement reclaim it. Focus the person moved themselves is never taken:
   * the flag is cleared the moment focus lands anywhere this component did not
   * put it.
   */
  let handedTranscriptFocus = false;

  function handOffFocusFromApproval(nextPending: PendingApproval | null): void {
    const active = document.activeElement;
    if (active === null || approvalSection === null) return;
    const fromApproval = approvalSection.contains(active);
    const fromOurTranscriptHandoff = handedTranscriptFocus && active === chatTranscript();
    if (!fromApproval && !fromOurTranscriptHandoff) {
      handedTranscriptFocus = false;
      return;
    }
    if (nextPending === null) {
      focusChatTranscript();
      handedTranscriptFocus = chatTranscript() !== null;
      return;
    }
    approvalQuestion?.focus();
    handedTranscriptFocus = false;
  }

  async function decide(approved: boolean): Promise<void> {
    const asked = pending;
    if (asked === null || deciding) return;
    deciding = true;
    // Captured so a slow failure body cannot install its banner after the
    // question was answered elsewhere or the turn ended.
    const generation = readGeneration;
    const epoch = answerEpoch;
    const attempt = ++decisionAttempt;
    const controller = new AbortController();
    const stale = (): boolean =>
      attempt !== decisionAttempt ||
      pending?.callId !== asked.callId ||
      generation !== readGeneration ||
      epoch !== answerEpoch;
    decisionController = controller;
    try {
      const response = await fetch(`/api/server-owned/conversations/${id}/elicitation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The CALL ID travels with the answer. Without it a click that
        // lands after this question's run ended would settle whatever is
        // pending next — approving a note nobody was shown.
        body: JSON.stringify({ approved, callId: asked.callId }),
        signal: controller.signal,
      });
      // The question can change while this POST is in flight. A successful
      // response only answers the server; it does not authorize changing this
      // tab's controls for a different question.
      if (await handleDecisionResponse(response, stale)) return;
      completeDecisionSuccess();
    } catch (cause) {
      if (stale()) return;
      installDecisionFailure(toBannerFailure(cause));
    } finally {
      if (attempt === decisionAttempt) {
        deciding = false;
        if (decisionController === controller) decisionController = null;
      }
    }
  }

  /**
   * The stream is the source of truth for whether a question is outstanding,
   * in BOTH directions.
   *
   * This used to only adopt; a 250ms `GET …/elicitation` loop did the
   * clearing, which meant the component learned that a question had been
   * answered elsewhere by asking rather than by being told — with up to a
   * full interval of stale controls in between, offering a decision on a
   * question that could no longer be answered.
   *
   * Now `elicitation.requested` raises it and `elicitation.resolved` takes it
   * away, both on the connection that is already open. Adoption is keyed on
   * `callId` rather than on the frame's identity so that the hydrating read
   * below, which populates the same question in full, is not undone by a
   * re-adoption that would drop its arguments and bounce focus for a question
   * that never changed.
   *
   * Reads of `pending` are untracked: tracking the value this effect itself
   * writes would re-enter it.
   */
  $effect(() => {
    const asked = question;
    untrack(() => {
      if (asked === null) {
        if (pending !== null) applyPending(null);
        return;
      }
      if (pending?.callId === asked.callId) return;
      adoptStreamedQuestion(asked);
    });
  });

  /**
   * One turn's read lifecycle.
   *
   * There is no loop here any more. Every `GET …/elicitation` this component
   * makes is now demand-driven — one when a question arrives on the stream, to
   * hydrate the arguments the frame has no field for, and one after a 409, to
   * re-read a question the server says has moved on. What this effect owns is
   * the state those reads are scoped by: the abort signal that stops one in
   * flight, the generation that makes a late response from a finished turn
   * inert, and the answer epoch.
   */
  $effect(() => {
    if (!streaming) {
      invalidateDecision();
      handOffFocusFromApproval(null);
      pending = null;
      // CLEARED, because nothing reads after this to clear it. A read that
      // failed just before an otherwise successful turn ended used to leave
      // its `role="alert"` text on screen indefinitely, describing a
      // background request rather than the turn the reader just watched
      // finish.
      clearReadFailure();
      // Bumped here too, so a response still in flight from the session that
      // just ended cannot land and restore its controls.
      readGeneration += 1;
      return;
    }

    const controller = new AbortController();
    readController = controller;
    answerEpoch = 0;
    readFailure = null;

    return () => {
      controller.abort();
      if (readController === controller) readController = null;
      clearReadFailure();
      readGeneration += 1;
    };
  });
</script>

<!--
	The approval a run is waiting on.

	A LIVE REGION that is always mounted and empty until there is a question,
	following the same rule as every other announcing region in this lab: one
	mounted with its text already in place is not reliably announced. The
	CONTROLS are conditional — a disabled Approve button for a question nobody
	asked would be reachable by keyboard and mean nothing.

	`role="status"` rather than `alert`: a question is not an error, and `alert`
	interrupts whatever the screen reader was saying about the reply now
	streaming.
-->
<section class="approval" aria-labelledby="approval-heading" bind:this={approvalSection}>
  <h2 id="approval-heading" class="visually-hidden">Approval</h2>
  <!--
		THE ANNOUNCEMENT and THE ARGUMENTS are separate elements, because two
		earlier fixes collided when they were one.

		Moving focus to a replacement question needs this element programmatically
		focusable, which `tabindex="-1"` gives. Bounding a long note's height
		made the same element a SCROLL container — and `-1` keeps a scroll
		container out of the tab order, so a sighted keyboard-only user could
		reach Approve with no way to read the rest of what they were authorizing.
		Making it `0` instead put a tab stop on a non-interactive element, which
		Svelte's own a11y rule rejects, correctly.

		So the sentence announces and stays unfocusable-by-tab, and the proposed
		arguments live in their own `role="region"` with a name and a real tab
		stop. That is also the better shape on its own terms: one is a sentence,
		the other is a block someone may have to scroll.
	-->
  <p
    class="approval-question"
    role="status"
    data-testid="approval-question"
    bind:this={approvalQuestion}
    tabindex="-1"
  >
    {#if pending}
      {pending.message}{#if pending.toolName}{' '}The assistant wants to run {pending.toolName}.{/if}
    {/if}
  </p>
  {#if pending?.arguments && pending.toolName}
    <!--
			A DISCLOSURE, not a scrollable box, and that was the third attempt.

			A bounded `overflow: auto` region needs `tabindex="0"` for its scroll
			to be reachable without a mouse — which Svelte's
			`a11y_no_noninteractive_tabindex` rejects for a non-interactive
			element, correctly: a focusable element that does nothing is a dead
			tab stop, and `role="region"` does not change that.

			`<summary>` is natively focusable and operable, so the keyboard path
			comes for free. Closed it costs one line, which is what keeps the
			transcript's space on a short viewport; open it shows the whole note
			and the page scrolls, which is already permitted while a question is
			pending. Nothing is hidden from the person deciding, and nothing is
			suppressed to make the linter quiet.
		-->
    <details class="approval-arguments" data-testid="approval-arguments">
      <summary>{`Arguments proposed for ${pending.toolName}`}</summary>
      <pre>{JSON.stringify(pending.arguments, null, 1)}</pre>
    </details>
  {/if}
  {#if pending}
    <!--
			THE CONTROLS do not wait on the disclosure above.

			The question and its call id arrive on the stream; the proposed
			arguments come from a second read that can be slower, or fail. Gating
			Approve and Deny on that read would put the side channel back on the
			critical path — a person would be shown a question they could not act
			on, which is worse than a question shown without its detail.
		-->
    <div class="approval-actions">
      <button
        type="button"
        data-testid="approval-approve"
        aria-disabled={deciding}
        onclick={() => void decide(true)}
      >
        Approve
      </button>
      <button
        type="button"
        data-testid="approval-deny"
        aria-disabled={deciding}
        onclick={() => void decide(false)}
      >
        Deny
      </button>
    </div>
  {/if}
</section>

<style>
  .approval {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .approval-question:empty {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .approval-question {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--cinder-status-warning-border, currentColor);
    border-radius: 0.5rem;
    background: var(--cinder-status-warning-background, transparent);
  }

  .approval-arguments {
    border: 1px solid var(--cinder-border);
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
  }

  .approval-arguments summary {
    cursor: pointer;
  }

  .approval-arguments pre {
    margin: 0.5rem 0 0;
    font-family: var(--cinder-font-mono, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .approval-actions {
    display: flex;
    gap: 0.5rem;
  }

  .approval-actions button {
    padding: 0.35rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid var(--cinder-border);
    background: var(--cinder-surface);
    cursor: pointer;
  }

  .approval-actions button[aria-disabled='true'] {
    cursor: not-allowed;
    color: var(--cinder-text-disabled);
  }

  .visually-hidden {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
