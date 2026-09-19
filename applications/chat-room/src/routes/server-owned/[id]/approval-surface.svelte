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
     * THE PRIMARY PATH. Until it existed, the side channel below was the only
     * way this component learned a question had been asked: nothing on the
     * response said so, so it asked `…/elicitation` every 250ms and a client
     * whose poll could not get through had a run parked on a question it would
     * never show.
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

  let pollGeneration = 0;

  let answerEpoch = 0;

  let pollController: AbortController | null = null;
  let decisionController: AbortController | null = null;
  let decisionAttempt = 0;

  function clearPollFailure(): void {
    if (pollFailure !== null && failure === pollFailure) failure = null;
    pollFailure = null;
  }

  let pollFailure: BannerFailure | null = null;

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
    void readPendingApproval(pollGeneration, pollController?.signal);
  }

  function applyPending(nextPending: PendingApproval | null): void {
    const answeredOrChanged = nextPending === null || nextPending.callId !== pending?.callId;
    if (answeredOrChanged) {
      invalidateDecision();
      handOffFocusFromApproval(nextPending);
    }
    pending = nextPending;
    clearPollFailure();
  }

  function installDecisionFailure(reported: BannerFailure): void {
    decideFailure = reported;
    failure = reported;
  }

  function clearDecisionFailure(): void {
    if (decideFailure !== null && failure === decideFailure) failure = null;
    decideFailure = null;
  }

  function installPollFailure(reported: BannerFailure): void {
    // A poll failure is secondary context. Preserve a decision or controller
    // failure while polling recovers, and let clearPollFailure remove only a
    // banner this poll path actually owns.
    if (failure !== null && failure !== pollFailure) return;
    pollFailure = reported;
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
      if (!stale()) installPollFailure(toBannerFailure(new Error(message)));
      return;
    }
    const body: unknown = await response.json();
    if (stale()) return;
    if (!isPendingBody(body)) {
      installPollFailure(toBannerFailure(new Error('Approval response was invalid.')));
      return;
    }
    applyPending(body.pending);
  }

  async function handleDecisionResponse(
    response: Response,
    stale: () => boolean,
  ): Promise<boolean> {
    if (stale()) return true;
    if (response.status === 409) {
      answerEpoch += 1;
      await readPendingApproval(pollGeneration, pollController?.signal);
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
    const stale = (): boolean => generation !== pollGeneration || epoch !== answerEpoch;
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
      installPollFailure(reported);
    }
  }

  function focusChatTranscript(): void {
    const transcript = approvalSection?.parentElement?.querySelector<HTMLElement>(
      '[data-testid="server-owned-chat"] [role="log"]',
    );
    transcript?.focus();
  }

  function handOffFocusFromApproval(nextPending: PendingApproval | null): void {
    const active = document.activeElement;
    if (active === null || approvalSection === null) return;
    if (!approvalSection.contains(active)) return;
    if (nextPending === null) {
      focusChatTranscript();
      return;
    }
    approvalQuestion?.focus();
  }

  async function decide(approved: boolean): Promise<void> {
    const asked = pending;
    if (asked === null || deciding) return;
    deciding = true;
    // Captured so a slow failure body cannot install its banner after the
    // question was answered elsewhere or the turn ended.
    const generation = pollGeneration;
    const epoch = answerEpoch;
    const attempt = ++decisionAttempt;
    const controller = new AbortController();
    const stale = (): boolean =>
      attempt !== decisionAttempt ||
      pending?.callId !== asked.callId ||
      generation !== pollGeneration ||
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
   * Adopts each new question the stream raises.
   *
   * Keyed on `callId`, not on the frame's identity: the periodic read below
   * can land first and populate the same question in full, and re-adopting it
   * would drop the arguments that read supplied and bounce focus for a
   * question that never changed.
   *
   * The reads of `pending` are untracked so this runs when a QUESTION
   * arrives — tracking the value this effect itself writes would re-enter it.
   */
  $effect(() => {
    const asked = question;
    if (asked === null) return;
    untrack(() => {
      if (pending?.callId === asked.callId) return;
      adoptStreamedQuestion(asked);
    });
  });

  $effect(() => {
    if (!streaming) {
      invalidateDecision();
      handOffFocusFromApproval(null);
      pending = null;
      // CLEARED, because nothing polls after this to clear it. A poll that
      // failed just before an otherwise successful turn ended used to leave
      // its `role="alert"` text on screen indefinitely, describing a
      // background request rather than the turn the reader just watched
      // finish.
      clearPollFailure();
      // Bumped here too, so a response still in flight from the session that
      // just ended cannot land and restore its controls.
      pollGeneration += 1;
      return;
    }

    const generation = pollGeneration;
    const controller = new AbortController();
    pollController = controller;
    answerEpoch = 0;
    pollFailure = null;
    let stopped = false;

    const loop = async (): Promise<void> => {
      for (;;) {
        if (stopped || generation !== pollGeneration) break;
        await readPendingApproval(generation, controller.signal);
        if (stopped || generation !== pollGeneration) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    void loop();

    return () => {
      stopped = true;
      controller.abort();
      if (pollController === controller) pollController = null;
      clearPollFailure();
      pollGeneration += 1;
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
