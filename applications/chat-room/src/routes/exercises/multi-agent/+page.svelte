<script lang="ts">
  import { Chat } from '@repo/chat';
  import { page } from '$app/state';

  import { delegate } from './multi-agent-delegation.ts';

  const failing = $derived(page.url.searchParams.get('fail') === '1');

  const panels = $derived.by(() => {
    const built = [
      {
        id: 'summary',
        label: "returnMode: 'summary' (cap 40)",
        note: 'The default summarizer caps the answer. It does not condense it.',
        promise: delegate('summary', { returnMode: 'summary' }),
      },
      {
        id: 'full',
        label: "returnMode: 'full'",
        note: "The child's answer crosses back whole, at whatever length it happens to be.",
        promise: delegate('full', { returnMode: 'full' }),
      },
      {
        id: 'custom',
        label: "returnMode: 'summary' with a caller-supplied summarizer",
        note: 'Where real condensation lives — the seam the default fills with a cap.',
        promise: delegate('custom', { returnMode: 'summary', useCustomSummarizer: true }),
      },
    ];

    if (failing) {
      built.push({
        id: 'induced',
        label: 'An induced failure',
        note: 'Only reachable with ?fail=1, so the announcer has a path to exercise.',
        promise: Promise.reject(new Error('Induced delegation failure.')),
      });
    }

    return built;
  });

  let settledCount = $state(0);
  let announcement = $state('');

  $effect(() => {
    const current = panels;
    settledCount = 0;
    announcement = '';
    let live = true;

    for (const panel of current) {
      const settle = (): void => {
        if (live) settledCount += 1;
      };
      void panel.promise.then(settle, (cause: unknown) => {
        if (live) {
          announcement = `The ${panel.id} delegation failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        }
        settle();
      });
    }

    return () => {
      live = false;
    };
  });

  const summaryPanel = $derived(panels[0]);
</script>

<main>
  <h1>Multi-agent — delegating to a subagent</h1>
  <p>
    Three independent runs, one per setting below. Each builds its own parent agent, its own
    researcher subagent, and makes exactly one <code>createSubagentTool</code> delegation — they
    differ only in what is asked to come back across the boundary. With the default summarizer,
    <code>'summary'</code> hard-truncates; condensation is something the caller supplies.
  </p>

  <!--
		One concise, persistent status line rather than an `aria-live` region
		around each result table: it exists at mount, since a live region
		inserted along with its content announces unreliably.
	-->
  <p role="status" data-testid="multi-agent-status">
    {settledCount} of {panels.length} delegations settled.
  </p>

  <!--
		Mounted ALWAYS, empty until a delegation rejects. Registered in
		`exercises/error-live-regions.e2e.ts`, whose list is exhaustive by its
		own contract — a new error region that is not in it is the omission that
		spec was written after finding seven times.
	-->
  <p role="alert" data-testid="multi-agent-failure">{announcement}</p>

  <section data-testid="multi-agent-transcript">
    <h2>The delegation, in Chat's transcript</h2>
    <p>
      The <code>'summary'</code> delegation above, rendered by
      <code>&lt;Chat&gt;</code>. A completed tool-call/tool-result pair renders as a grouped
      tool-activity row; expanding it shows the arguments the parent sent and the result that
      crossed back.
    </p>
    {#if summaryPanel}
      {#await summaryPanel.promise}
        <p data-testid="multi-agent-transcript-pending">Running…</p>
      {:then delegation}
        <div data-testid="multi-agent-chat">
          <Chat id="multi-agent-chat" conversation={delegation.history} />
        </div>
      {:catch failure}
        <!--
				A `{:catch}` arm on every `{#await}`, so a failed delegation is
				reported rather than rendering nothing. Without it the page shows
				a silent gap and the specs report a missing element, which names
				the symptom instead of the run that failed.
			-->
        <p data-testid="multi-agent-transcript-failed">
          The delegation failed: {failure instanceof Error ? failure.message : String(failure)}
        </p>
      {/await}
    {/if}
  </section>

  {#each panels as panel (panel.id)}
    <section data-testid="multi-agent-{panel.id}">
      <h2>{panel.label}</h2>
      <p>{panel.note}</p>
      {#await panel.promise}
        <p data-testid="multi-agent-{panel.id}-pending">Running…</p>
      {:then delegation}
        <dl>
          <dt>finishReason</dt>
          <dd data-testid="multi-agent-{panel.id}-finish">{delegation.finishReason}</dd>
          <dt>parent generate calls</dt>
          <dd data-testid="multi-agent-{panel.id}-parent-calls">
            {delegation.parentGenerateCalls}
          </dd>
          <dt>child generate calls</dt>
          <dd data-testid="multi-agent-{panel.id}-child-calls">{delegation.childGenerateCalls}</dd>
          <dt>tool executions</dt>
          <dd data-testid="multi-agent-{panel.id}-tool-executions">{delegation.toolExecutions}</dd>
          <dt>question the child received</dt>
          <dd data-testid="multi-agent-{panel.id}-received">{delegation.childReceived}</dd>
          <dt>transcript roles</dt>
          <dd data-testid="multi-agent-{panel.id}-roles">{delegation.transcriptRoles}</dd>
          <dt>returned characters</dt>
          <dd data-testid="multi-agent-{panel.id}-length">{delegation.returnedLength}</dd>
          <dt>identical to the child's answer</dt>
          <dd data-testid="multi-agent-{panel.id}-whole">{delegation.keepsWholeAnswer}</dd>
          <dt>shorter than the child's answer</dt>
          <dd data-testid="multi-agent-{panel.id}-shortened">{delegation.shortenedFromChild}</dd>
          <dt>opens with the child's own words</dt>
          <dd data-testid="multi-agent-{panel.id}-opening">{delegation.keepsChildOpening}</dd>
          <dt>verbatim prefix of the child's answer</dt>
          <dd data-testid="multi-agent-{panel.id}-prefix">{delegation.verbatimPrefixLength}</dd>
          <dt>cuts mid-sentence</dt>
          <dd data-testid="multi-agent-{panel.id}-mid-sentence">{delegation.cutsMidSentence}</dd>
          <dt>equals this page's summarizer output</dt>
          <dd data-testid="multi-agent-{panel.id}-custom">{delegation.matchesCustomSummary}</dd>
        </dl>
      {:catch failure}
        <p data-testid="multi-agent-{panel.id}-failed">
          The delegation failed: {failure instanceof Error ? failure.message : String(failure)}
        </p>
      {/await}
    </section>
  {/each}
</main>

<style>
  main {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
    font-family: monospace;
  }

  /*
	 * At 320 CSS pixels a `max-content` label column cannot shrink, pushing
	 * the value column off-screen and making a reader at high zoom pan
	 * sideways to pair a term with its value. Stack once there is no room.
	 */
  @media (max-width: 32rem) {
    dl {
      grid-template-columns: 1fr;
      gap: 0;
    }

    dt {
      margin-block-start: 0.75rem;
    }
  }
</style>
