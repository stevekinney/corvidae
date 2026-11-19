<script lang="ts">
  /**
   * `/`: Home, the first item in the sidebar and the page the app opens on. Its heading is Cinder's
   * `visually-hidden` wrapper, so the page shows no heading of its own: the breadcrumb already says
   * "Home", and Home's heading row carries no status or actions. The date line leads the content,
   * then the page's one focal value, a Spotlight that says how many reviews wait on you, with the
   * link to Reviews beside it (`home-focus.svelte`), then two columns: what needs you (titled by the
   * Spotlight, so it draws no heading of its own) with the one count Home lists nowhere else after
   * it (`home-counts.svelte`), what is running and what needs attention at the left, each one
   * grouped list, the box that
   * starts a chat at the right, and the chats you were last in across the full width below
   * (`home-layout.svelte`), then the last region, the two activity bands: Workflow activity and
   * Agent activity (`home-workflow-activity.svelte`, `home-agent-activity.svelte`), which the
   * first-run checklist does not show.
   *
   * Each card reads on its own, so one that cannot be read says so in its own place and the rest
   * stay live. Running now is there only while a run is going.
   *
   * On a new installation the page is the first-run checklist alone (`useHomeFirstRun`,
   * `home-first-run.svelte`, owner 2026-11-19): its own visible heading in place of the hidden one,
   * one sentence and the steps, and no date line, counts, Needs you, Needs attention, box that
   * starts a chat, Recent chats or activity. Recent chats appears once a chat exists.
   *
   * Around the cards sits the page's phase (`useHomePhase`): placeholders in the page's own layout
   * until the first reads have answered, so the overview is never drawn only to be replaced or
   * filled in; "Loading canceled" after a slow load was canceled; the full error state when the
   * server does not answer and nothing has loaded, in place of the shell's banner. When the server
   * stops answering with data on screen the page keeps it at full contrast and the shell's banner
   * names its age, and only the controls that change something are held.
   */
  import { ErrorState, VisuallyHidden } from '@lostgradient/cinder';
  import { Ban } from '@lucide/svelte';

  import { CONNECTION_COPY, RETRY_LABEL } from '../../app/copy/views.ts';
  import { HOME_COPY } from '../../app/copy/home.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { dateLine, timesShowIn } from '../../lib/format/clock.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCounts from './home-counts.svelte';
  import HomeFirstRun from './home-first-run.svelte';
  import HomeFocus from './home-focus.svelte';
  import { useHomeFirstRun } from './home-first-run.svelte.ts';
  import { useChatReadiness } from '../../app/chat-readiness.svelte.ts';
  import HomeLayout from './home-layout.svelte';
  import HomeLoading from './home-loading.svelte';
  import HomeNeedsAttention from './home-needs-attention.svelte';
  import HomeNeedsYou from './home-needs-you.svelte';
  import { useHomePhase } from './home-phase.svelte.ts';
  import { useRunningTasks } from './home-queries.svelte.ts';
  import HomeRecentChats from './home-recent-chats.svelte';
  import HomeRunningNow from './home-running-now.svelte';
  import HomeStartChat from './home-start-chat.svelte';
  import HomeAgentActivity from './home-agent-activity.svelte';
  import HomeWorkflowActivity from './home-workflow-activity.svelte';

  // The day and the zone's name follow the clock the page reads, so a page left open past midnight
  // says the new day.
  const clock = useMinuteClock();
  const connection = getConnection();
  const firstRun = useHomeFirstRun();
  const homePhase = useHomePhase(firstRun);
  const running = useRunningTasks();

  const readiness = useChatReadiness();

  const mode = $derived(firstRun.mode());
  const phase = $derived(homePhase.phase());
  // The checklist is the whole page, with its own visible heading.
  const firstRunShown = $derived(
    mode === 'checklist' && phase !== 'loading' && phase !== 'canceled' && phase !== 'unreachable',
  );
  // Running now is a card only while a run is going.
  const runningNow = $derived(running.data ?? []);

  // With nothing to show but the unreachable state, the page says it itself and the shell's banner
  // stays out (never both).
  $effect(() => {
    connection.setShownInPlace(phase === 'unreachable');
    return () => connection.setShownInPlace(false);
  });
</script>

{#if !firstRunShown}<VisuallyHidden as="h1">{HOME_COPY.heading}</VisuallyHidden>{/if}

{#if phase === 'loading'}
  <HomeLoading onCancel={homePhase.cancel} />
{:else if phase === 'canceled'}
  <div class="ib-home-stopped" data-page="home" data-mode="canceled">
    <p class="ib-home-stopped__date" data-testid="home-date">
      {dateLine(clock())}. {timesShowIn(clock())}.
    </p>
    <ErrorState
      tone="neutral"
      title={HOME_COPY.states.canceled.title}
      description={HOME_COPY.states.canceled.description}
      retryLabel={RETRY_LABEL}
      onRetry={homePhase.retry}
      data-testid="home-canceled"
    >
      {#snippet icon()}<Ban aria-hidden="true" />{/snippet}
    </ErrorState>
  </div>
{:else if phase === 'unreachable'}
  <div class="ib-home-stopped" data-page="home" data-mode="unreachable">
    <ErrorState
      title={CONNECTION_COPY.page.title}
      description={CONNECTION_COPY.page.description}
      retryLabel={RETRY_LABEL}
      onRetry={homePhase.retry}
      data-testid="home-unreachable"
    />
  </div>
{:else if firstRunShown}
  <div class="ib-home-first-run-page" data-page="home" data-mode="checklist">
    <HomeFirstRun
      steps={firstRun.steps()}
      assistant={firstRun.assistant()}
      readiness={readiness()}
      onUseAssistant={firstRun.useAssistant}
    />
  </div>
{:else}
  <HomeLayout
    {mode}
    {date}
    focus={focusRow}
    primary={primaryCard}
    counts={countsRow}
    running={runningNow.length > 0 ? runningCard : undefined}
    attention={attentionCard}
    startChatAside={startChatCard}
    recent={recentCard}
    workflowActivity={workflowActivityBand}
    agentActivity={agentActivityBand}
  />
{/if}

{#snippet date()}{dateLine(clock())}. {timesShowIn(clock())}.{/snippet}
{#snippet focusRow()}<HomeFocus />{/snippet}
{#snippet countsRow()}<HomeCounts />{/snippet}
{#snippet primaryCard()}<HomeNeedsYou />{/snippet}
{#snippet runningCard()}<HomeRunningNow tasks={runningNow} />{/snippet}
{#snippet startChatCard()}<HomeStartChat />{/snippet}
{#snippet attentionCard()}<HomeNeedsAttention />{/snippet}
{#snippet recentCard()}<HomeRecentChats />{/snippet}
{#snippet workflowActivityBand()}<HomeWorkflowActivity />{/snippet}
{#snippet agentActivityBand()}<HomeAgentActivity />{/snippet}

<style>
  .ib-home-stopped {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-inline-size: 0;
  }

  .ib-home-stopped__date {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-base);
  }
</style>
