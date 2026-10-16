<script lang="ts">
  import { Button, Segment, SegmentedControl, Toggle } from '@lostgradient/cinder';
  import { Terminal } from '@lostgradient/terminal';
  import { onMount } from 'svelte';

  import {
    isProfileIdentifier,
    PROFILE_DESCRIPTIONS,
    PROFILE_IDENTIFIERS,
  } from '../shared/profile-catalog.ts';
  import { channelView } from './channel-view.ts';
  import { SessionModel } from './session-model.svelte.ts';

  const model = new SessionModel();
  let announceOutput = $state(false);
  let mouseReporting = $state(false);

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
    state: model.state,
    error: model.message ?? '',
    cleanupPending: model.cleanupPending,
    announceOutput,
    ...ownerGeometry,
  });
  const actions = {
    onNewSession: () => void model.begin(),
    onTryAgain: () => void model.begin(),
    onRetry: () => void model.begin(),
    onCheckCleanup: () => void model.checkCleanup(),
    onCancel: () => model.cancel(),
  };

  onMount(() => {
    void model.begin();
  });

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
