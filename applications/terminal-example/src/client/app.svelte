<script lang="ts">
  import { Button, Collapsible, Segment, SegmentedControl, Toggle } from '@lostgradient/cinder';
  import { Terminal, type TerminalState } from '@lostgradient/terminal';
  import { onMount } from 'svelte';

  import {
    isProfileIdentifier,
    PROFILE_DESCRIPTIONS,
    PROFILE_IDENTIFIERS,
  } from '../shared/profile-catalog.ts';
  import { channelView } from './channel-view.ts';
  import { SessionModel, type FaultMode, type HoldPoint } from './session-model.svelte.ts';

  const model = new SessionModel();
  let announceOutput = $state(false);
  let mouseReporting = $state(false);

  // Review controls. Everything below changes what the page shows or when it acts; none of it lets
  // the page choose a command, an argument, a directory or an environment.
  const REMOVAL_SECONDS = 8;
  let theme = $state<'light' | 'dark'>('light');
  /** A state the page hands the terminal in place of the session's own. Always labelled as injected. */
  let injected = $state<TerminalState | undefined>(undefined);
  let linksEnabled = $state(false);
  let lastLink = $state<string | undefined>(undefined);
  let removalCountdown = $state<number | undefined>(undefined);
  let removalTimer: ReturnType<typeof setInterval> | undefined;

  const live = $derived(
    model.state === 'writable' || model.state === 'read-only' || model.state === 'backpressured',
  );
  const description = $derived(PROFILE_DESCRIPTIONS[model.profile]);
  // A profile the server never gives input to has no grid of its own to fit: it shows the size it was written for.
  const ownerGeometry = $derived(
    description.interactive ? {} : { ownerGeometry: { columns: 80, rows: 24 } },
  );
  // Props the terminal leaves off rather than takes as `undefined`.
  const sessionProps = $derived({
    state: injected ?? model.state,
    error:
      injected === 'cleanup-incomplete'
        ? 'Injected by the review controls: the host reported no cleanup result.'
        : (model.message ?? ''),
    onRecoveryRequest: () => {
      injected = undefined;
    },
    cleanupPending: model.cleanupPending,
    announceOutput,
    ...ownerGeometry,
  });
  const actions = {
    onNewSession: () => void model.begin(),
    onTryAgain: () => void model.begin(),
    onRetry: () => void model.begin(),
    onCheckCleanup: () => void checkCleanup(),
    onCancel: () => model.cancel(),
  };

  onMount(() => {
    // `?autostart=off` leaves the page in `empty`, so the first state a reviewer sees is the empty one.
    const autostart = new URLSearchParams(window.location.search).get('autostart') !== 'off';
    if (autostart) void model.begin();
    return () => stopRemoval();
  });

  async function injectCleanupIncomplete(): Promise<void> {
    await model.end();
    injected = 'cleanup-incomplete';
  }

  async function checkCleanup(): Promise<void> {
    await model.checkCleanup();
    if (injected === 'cleanup-incomplete') injected = undefined;
  }

  const LONG_LINE_CHARACTERS = 60_000;
  let copyStatus = $state('Nothing copied.');

  /** Put one long single line on the clipboard: under the paste limit, so it skips the paste review. */
  async function copyLongLine(): Promise<void> {
    const line = '0123456789'.repeat(LONG_LINE_CHARACTERS / 10);
    try {
      await navigator.clipboard.writeText(line);
      copyStatus = `Copied ${line.length} characters on one line. Paste them into the terminal.`;
    } catch {
      copyStatus = 'The browser did not allow copying. Allow clipboard access and try again.';
    }
  }

  function chooseTheme(value: unknown): void {
    if (value !== 'light' && value !== 'dark') return;
    theme = value;
    document.documentElement.dataset['theme'] = value;
  }

  function chooseHold(value: unknown): void {
    if (value === 'none' || value === 'loading' || value === 'connecting') {
      model.hold = value satisfies HoldPoint;
    }
  }

  function chooseFault(value: unknown): void {
    if (value === 'none' || value === 'denied' || value === 'failed') {
      model.fault = value satisfies FaultMode;
    }
  }

  function openLink(url: string): void {
    lastLink = url;
    // The terminal offers visible HTTPS text only; the host still opens it without an opener.
    if (new URL(url).protocol === 'https:') window.open(url, '_blank', 'noopener');
  }

  function stopRemoval(): void {
    clearInterval(removalTimer);
    removalTimer = undefined;
    removalCountdown = undefined;
  }

  /** After a delay, show a state without an engine, which takes the toolbar and its `Export` button with it. */
  function scheduleToolbarRemoval(): void {
    stopRemoval();
    removalCountdown = REMOVAL_SECONDS;
    removalTimer = setInterval(() => {
      const left = (removalCountdown ?? 1) - 1;
      if (left > 0) {
        removalCountdown = left;
        return;
      }
      stopRemoval();
      injected = 'engine-load-failed';
    }, 1000);
  }

  function chooseProfile(value: unknown): void {
    if (!isProfileIdentifier(value) || value === model.profile) return;
    model.profile = value;
    void model.begin();
  }

  function chooseReadOnly(next: boolean): void {
    model.readOnly = next;
    void model.begin();
  }
</script>

<main>
  <header>
    <h1>Terminal example</h1>
    <p>
      A browser terminal backed by a process this server owns. The page picks one of four
      server-owned profiles; it never sends a command, an argument, a directory or an environment.
    </p>
  </header>

  <section class="controls" aria-label="Session controls">
    <SegmentedControl
      id="profile"
      label="Profile"
      value={model.profile}
      onValueChange={chooseProfile}
    >
      {#each PROFILE_IDENTIFIERS as identifier (identifier)}
        <Segment value={identifier}>{PROFILE_DESCRIPTIONS[identifier].label}</Segment>
      {/each}
    </SegmentedControl>
    <Toggle
      id="read-only"
      label="Open read-only"
      checked={model.readOnly}
      onValueChange={chooseReadOnly}
    />
    <Toggle id="announce-output" label="Announce output" bind:checked={announceOutput} />
    <Toggle id="mouse-reporting" label="Report the mouse" bind:checked={mouseReporting} />
    <Button variant="secondary" label="End session" disabled={!live} onclick={() => model.end()} />
    <Button
      variant="secondary"
      label="Drop connection"
      disabled={!live}
      onclick={() => model.drop()}
    />
  </section>

  <Collapsible trigger="Review controls" idBase="review-controls">
    <section class="review" aria-labelledby="review-heading">
      <h2 id="review-heading">Review controls</h2>
      <p>
        These controls put the terminal into each state in the specification and hold it there for a
        human review. They change what this page shows or when it acts. They never choose a command,
        an argument, a directory or an environment: the server owns every profile. Controls marked
        injected hand the terminal a state without the fault behind it, and say so.
      </p>

      <div class="review-group" role="group" aria-label="Appearance">
        <SegmentedControl id="theme" label="Theme" value={theme} onValueChange={chooseTheme}>
          <Segment value="light">Light</Segment>
          <Segment value="dark">Dark</Segment>
        </SegmentedControl>
      </div>

      <div class="review-group" role="group" aria-label="Session start">
        <p>
          Real states. Open the page with <code>?autostart=off</code> to start in empty, or use Show empty.
          Hold applies to the next session and lasts until released; Cancel works while it is held.
        </p>
        <SegmentedControl
          id="hold"
          label="Hold the next session at"
          value={model.hold}
          onValueChange={chooseHold}
        >
          <Segment value="none">Off</Segment>
          <Segment value="loading">Loading</Segment>
          <Segment value="connecting">Connecting</Segment>
        </SegmentedControl>
        <Button variant="secondary" label="Show empty" onclick={() => model.showEmpty()} />
        <Button variant="secondary" label="Start a session" onclick={() => void model.begin()} />
        <Button
          variant="secondary"
          label="Release held session"
          disabled={model.held === undefined}
          onclick={() => model.release()}
        />
        <p data-testid="hold-status">
          {model.held === undefined
            ? 'Nothing is held.'
            : `Held at ${model.held}: the page has not taken the next step.`}
        </p>
      </div>

      <div class="review-group" role="group" aria-label="Refusals">
        <p>
          Real server refusals. Denied sends a ticket the server never issued, and Failed asks for a
          profile the server does not have; the refusal is the server's own either way.
        </p>
        <SegmentedControl
          id="fault"
          label="Make the next session end in"
          value={model.fault}
          onValueChange={chooseFault}
        >
          <Segment value="none">Nothing</Segment>
          <Segment value="denied">Denied</Segment>
          <Segment value="failed">Failed</Segment>
        </SegmentedControl>
      </div>

      <div class="review-group" role="group" aria-label="Backpressure and cleanup">
        <p>
          Backpressure is real. Choose the Stalled input profile, copy a long line, and paste it
          into the terminal: the program is not reading, so the host holds the input, the terminal
          shows Backpressure: input paused, and the output stays readable. When the program reads
          again, after 20 seconds, the terminal returns to Connected. There is no Cancel in that
          state, because nothing is waiting to be sent. Cleanup incomplete is real too: the Escaped
          job profile makes it, and injecting it here ends the session first, so Check cleanup
          reports the real, complete result.
        </p>
        <Button variant="secondary" label="Copy a long line" onclick={() => void copyLongLine()} />
        <p data-testid="copy-status">{copyStatus}</p>
        <Button
          variant="secondary"
          label="Inject cleanup incomplete"
          onclick={() => void injectCleanupIncomplete()}
        />
      </div>

      <div class="review-group" role="group" aria-label="Engine and toolbar">
        <p>
          Injected: the page passes the terminal an engine-load-failed state. No engine failure
          happened. Retry hands control back to the session. Removing the toolbar does the same
          after a delay, so you can open Export first and watch where focus goes when it closes.
        </p>
        <Button
          variant="secondary"
          label="Inject engine load failure"
          onclick={() => (injected = 'engine-load-failed')}
        />
        <Button
          variant="secondary"
          label={`Remove the toolbar in ${REMOVAL_SECONDS} seconds`}
          disabled={removalCountdown !== undefined}
          onclick={scheduleToolbarRemoval}
        />
        <Button
          variant="secondary"
          label="Clear the injected state"
          disabled={injected === undefined}
          onclick={() => (injected = undefined)}
        />
        <p data-testid="injection-status">
          {injected === undefined
            ? 'Showing the session’s own state.'
            : `Showing ${injected}: injected by this page. The session underneath is ${model.state}.`}
          {#if removalCountdown !== undefined}
            The toolbar is removed in {removalCountdown}.
          {/if}
        </p>
      </div>

      <div class="review-group" role="group" aria-label="Links">
        <p>
          Links are off by default. Turn them on to let the terminal offer visible HTTPS text only;
          the page opens it in a new tab without an opener. The Links profile prints one of each
          kind.
        </p>
        <Toggle id="links" label="Open visible HTTPS links" bind:checked={linksEnabled} />
        <p data-testid="link-status">
          {lastLink === undefined ? 'No link has been opened.' : `Last link opened: ${lastLink}`}
        </p>
      </div>
    </section>
  </Collapsible>

  <p class="summary" data-testid="profile-summary">{description.summary}</p>

  {#key model.generation}
    {#if model.profile === 'diagnostic'}
      <div class="pair">
        {#each [{ channel: 'stdout', title: 'Standard output' }, { channel: 'stderr', title: 'Standard error' }] as view (view.channel)}
          <div class="stage">
            <Terminal
              title={view.title}
              ariaLabel={view.title}
              {...sessionProps}
              {...actions}
              {...model.client === undefined
                ? {}
                : { controller: channelView(model.client, view.channel as 'stdout' | 'stderr') }}
            />
          </div>
        {/each}
      </div>
    {:else}
      <div class="stage">
        <Terminal
          title={description.title}
          ariaLabel={description.title}
          {...sessionProps}
          {...actions}
          {...model.client === undefined ? {} : { controller: model.client }}
          {mouseReporting}
          {...linksEnabled ? { onLinkActivate: openLink } : {}}
          onGeometryChange={(geometry) => model.setGeometry(geometry)}
        />
      </div>
    {/if}
  {/key}

  <section class="notes" aria-labelledby="notes-heading">
    <h2 id="notes-heading">What to try</h2>
    <ul>
      <li>
        <strong>Restart is a new session.</strong> When the process exits, or the connection ends, the
        terminal offers New session once the server has cleaned up. Nothing is replayed.
      </li>
      <li>
        <strong>Disconnect handling.</strong> Choose Drop connection. Input freezes at once, the server
        ends the process, and the terminal reports a disconnect rather than an exit.
      </li>
      <li>
        <strong>Paste review.</strong> Paste text with a line break into the shell. The review shows the
        line breaks and controls before anything is sent.
      </li>
      <li>
        <strong>Search, accessible output and export.</strong> The toolbar above the output searches the
        retained text, clears it locally, and opens a snapshot you can read, copy or download.
      </li>
      <li>
        <strong>Read-only mode.</strong> Turn on Open read-only. The server grants no input, the terminal
        sends nothing, and selection and scrolling still work. The pipe demo and the replay are always
        read-only.
      </li>
    </ul>
  </section>
</main>

<style>
  main {
    display: grid;
    gap: var(--cinder-space-4);
    max-inline-size: 72rem;
    margin-inline: auto;
    padding: var(--cinder-space-4);
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  header {
    display: grid;
    gap: var(--cinder-space-2);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-4);
  }

  .summary {
    color: var(--cinder-text-muted);
  }

  .stage {
    block-size: 28rem;
    min-inline-size: 0;
  }

  .review {
    display: grid;
    gap: var(--cinder-space-4);
    padding-block: var(--cinder-space-3);
  }

  .review-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .review-group p {
    flex-basis: 100%;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: var(--cinder-space-4);
  }

  .notes {
    display: grid;
    gap: var(--cinder-space-2);
  }

  .notes ul {
    display: grid;
    gap: var(--cinder-space-2);
    margin: 0;
    padding-inline-start: var(--cinder-space-5);
  }
</style>
