<script lang="ts">
  /**
   * `/`: Home, the first item in the sidebar and the page the app opens on. Its heading is Cinder's
   * `visually-hidden` wrapper, so the page shows no heading of its own: the breadcrumb already says
   * "Home", and Home's heading row carries no status or actions. The date line leads the content,
   * then the page's one focal value, a Spotlight that says how many reviews wait on you, with the
   * one count Home lists nowhere else under it (`home-focus.svelte`), then two columns: what needs
   * you, what is running and what needs attention at the left, each one grouped list, the box that
   * starts a chat at the right, and the chats you were last in across the full width below
   * (`home-layout.svelte`).
   *
   * Each card reads on its own, so one that cannot be read says so in its own place and the rest
   * stay live. Running now is there only while a run is going.
   *
   * On a new installation the page is the first-run checklist instead (`useHomeFirstRun`): it
   * leads with "Welcome. …" in place of the date line, and the Spotlight, Needs you and the provider
   * notice give way to the checklist, whose first step says the notice. The box that starts a chat
   * comes back below the checklist once a provider is connected, and Recent chats says there are
   * none yet.
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
  import HomeFirstRun from './home-first-run.svelte';
  import HomeFocus from './home-focus.svelte';
  import { useHomeFirstRun } from './home-first-run.svelte.ts';
  import HomeLayout from './home-layout.svelte';
  import HomeLoading from './home-loading.svelte';
  import HomeNeedsAttention from './home-needs-attention.svelte';
  import HomeNeedsYou from './home-needs-you.svelte';
  import { useHomePhase } from './home-phase.svelte.ts';
  import { useAttentionItems, useRunningTasks } from './home-queries.svelte.ts';
  import HomeRecentChats from './home-recent-chats.svelte';
  import HomeRunningNow from './home-running-now.svelte';
  import HomeStartChat from './home-start-chat.svelte';

  // The day and the zone's name follow the clock the page reads, so a page left open past midnight
  // says the new day.
  const clock = useMinuteClock();
  const connection = getConnection();
  const firstRun = useHomeFirstRun();
  const homePhase = useHomePhase(firstRun);
  const running = useRunningTasks();
  const attention = useAttentionItems();

  const mode = $derived(firstRun.mode());
  const phase = $derived(homePhase.phase());
  // Running now is a card only while a run is going.
  const runningNow = $derived(running.data ?? []);
  // While the checklist shows, its first step says there is no provider, so only the other
  // problems are worth a card of their own.
  const otherProblems = $derived(
    (attention.data ?? []).some((item) => item.kind !== 'no-provider'),
  );

  // With nothing to show but the unreachable state, the page says it itself and the shell's banner
  // stays out (never both).
  $effect(() => {
    connection.setShownInPlace(phase === 'unreachable');
    return () => connection.setShownInPlace(false);
  });
</script>

<VisuallyHidden as="h1">{HOME_COPY.heading}</VisuallyHidden>

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
{:else}
  <HomeLayout
    {mode}
    {date}
    focus={mode === 'overview' ? focusRow : undefined}
    primary={primaryCard}
    running={mode === 'overview' && runningNow.length > 0 ? runningCard : undefined}
    startChatBelow={mode === 'checklist' && firstRun.providerConnected()
      ? startChatCard
      : undefined}
    attention={mode === 'overview' || otherProblems ? attentionCard : undefined}
    startChatAside={mode === 'overview' ? startChatCard : undefined}
    recent={recentCard}
  />
{/if}

{#snippet date()}
  {#if mode === 'checklist'}
    {HOME_COPY.firstRun.lead(firstRun.left())}
  {:else}
    {dateLine(clock())}. {timesShowIn(clock())}.
  {/if}
{/snippet}
{#snippet focusRow()}<HomeFocus />{/snippet}
{#snippet primaryCard()}
  {#if mode === 'checklist'}
    <HomeFirstRun
      steps={firstRun.steps()}
      assistant={firstRun.assistant()}
      onUseAssistant={firstRun.useAssistant}
    />
  {:else}
    <HomeNeedsYou />
  {/if}
{/snippet}
{#snippet runningCard()}<HomeRunningNow tasks={runningNow} />{/snippet}
{#snippet startChatCard()}<HomeStartChat />{/snippet}
{#snippet attentionCard()}<HomeNeedsAttention omitProviderNotice={mode === 'checklist'} />{/snippet}
{#snippet recentCard()}<HomeRecentChats />{/snippet}

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
