<script lang="ts">
  /*
   * The fix control for one finding or diagnostic (COR-487). Nothing is computed until the
   * author asks. The proposal opens in place with focus on its heading, shows everything
   * that will change, and has one Apply. When no candidate exists it explains the specific
   * blocking constraints, offers a restore only if that restore passed the same check, and
   * otherwise gives a precise manual instruction and no button. There is no "Fix all".
   */
  import { Button } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { applyProposal, staleReason } from './theme-remediation-apply.ts';
  import type { RemediationFailure, RemediationProposal } from './theme-remediation-proposal.ts';
  import type { RemediationSubject } from './theme-remediation-subject.ts';
  import ThemeRemediationView from './theme-remediation-view.svelte';

  type Props = {
    controller: ThemeBuilderController;
    subject: RemediationSubject;
    /** Gamut and algorithm inputs the proposal was computed for; a change drops it. */
    inputsKey: string;
    /** Called after a successful Apply with the finding id and the announcement. */
    onfixed: (id: string, message: string) => void;
  };
  let { controller, subject, inputsKey, onfixed }: Props = $props();

  let proposal = $state.raw<RemediationProposal | null>(null);
  let failure = $state.raw<RemediationFailure | null>(null);
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let wrapper: HTMLElement | undefined = $state();
  let headingNode: HTMLElement | null = null;

  const shown = $derived(proposal ?? failure?.restore ?? null);
  const stale = $derived(shown === null ? null : staleReason(shown, controller.draft));

  // Any change to the gamut target or the subject drops what was computed for the old one. The
  // subject object is rebuilt on every render of its parent; only its identity (id) matters.
  const subjectId = $derived(subject.id);
  $effect(() => {
    void inputsKey;
    void subjectId;
    untrack(() => reset());
  });

  function reset(): void {
    proposal = null;
    failure = null;
    problem = null;
  }

  function focusHeading(): void {
    queueMicrotask(() => headingNode?.focus());
  }

  function focusTrigger(): void {
    queueMicrotask(() => wrapper?.querySelector<HTMLElement>('button')?.focus());
  }

  async function propose(): Promise<void> {
    busy = true;
    problem = null;
    const result = await subject.propose();
    busy = false;
    if (result.ok) {
      proposal = result.proposal;
      failure = null;
    } else {
      proposal = null;
      failure = result;
    }
    controller.announcement = result.ok
      ? `${result.proposal.label} proposal ready. Review the changes, then apply.`
      : result.message;
    focusHeading();
  }

  async function apply(): Promise<void> {
    const target = shown;
    if (target === null || busy) return;
    busy = true;
    const outcome = await applyProposal(controller, target, () => subject.recompute(target));
    busy = false;
    if (!outcome.ok) {
      problem = outcome.message;
      controller.announcement = outcome.message;
      return;
    }
    reset();
    onfixed(subject.id, outcome.message);
  }

  function cancel(): void {
    reset();
    controller.announcement = 'Cancelled. Nothing changed.';
    focusTrigger();
  }
</script>

<div class="remediation" bind:this={wrapper} data-testid="remediation" aria-busy={busy}>
  {#if shown === null && failure === null}
    <Button
      label={subject.buttonLabel}
      variant="secondary"
      size="sm"
      aria-label={subject.buttonName}
      disabled={busy}
      onclick={() => void propose()}
    />
  {/if}

  {#if failure !== null}
    <section
      class="blocked"
      aria-labelledby={`${subject.id}-blocked`}
      data-testid="remediation-blocked"
    >
      <h4
        id={`${subject.id}-blocked`}
        class="blocked__title"
        tabindex="-1"
        {@attach (node) => {
          headingNode = node;
        }}
      >
        No automatic fix
      </h4>
      <p class="blocked__message" data-testid="remediation-reason">{failure.message}</p>
      {#if failure.blockers.length > 0}
        <ul class="blocked__list" aria-label="Blocking constraints">
          {#each failure.blockers as blocker (blocker)}
            <li>{blocker}</li>
          {/each}
        </ul>
      {/if}
      {#if failure.restore === null && failure.manual !== null}
        <p class="blocked__message" data-testid="remediation-manual">{failure.manual}</p>
      {/if}
      {#if failure.restore === null}
        <Button label="Close" variant="secondary" size="sm" onclick={cancel} />
      {/if}
    </section>
  {/if}

  {#if shown !== null}
    <ThemeRemediationView
      proposal={shown}
      idBase={`remediation-${subject.id.replaceAll(/[^\w-]/g, '-')}`}
      {stale}
      {busy}
      onapply={() => void apply()}
      oncancel={cancel}
      heading={failure === null
        ? (node) => {
            headingNode = node;
          }
        : undefined}
    />
  {/if}
  {#if problem !== null}
    <p class="problem" role="alert" data-testid="remediation-problem">{problem}</p>
  {/if}
</div>

<style>
  .remediation {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .blocked {
    display: grid;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }
  .blocked__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .blocked__title:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow:
      0 0 0 var(--cinder-ring-offset) var(--cinder-ring-offset-color),
      0 0 0 calc(var(--cinder-ring-offset) + var(--cinder-ring-width)) var(--cinder-ring-color);
  }
  @media (forced-colors: active) {
    .blocked__title:focus-visible {
      outline: var(--cinder-ring-width) solid Highlight;
      outline-offset: 3px;
    }
  }
  .blocked__message,
  .problem {
    margin: 0;
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
  .blocked__list {
    margin: 0;
    padding-inline-start: 1.25rem;
    font-size: var(--cinder-text-sm);
  }
  .problem {
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
  }
</style>
