<script lang="ts" module>
  /**
   * @cinder
   * @category domain
   * @status alpha
   * @purpose Render a terminal session's screen, cursor, colors, and scrollback inside Cinder's TerminalFrame, with the selected engine mounted only in the browser.
   * @tag terminal
   * @tag pty
   * @useWhen Showing the output of a real terminal session, with a measured grid the host sizes its process to.
   * @avoidWhen Rendering a read-only log of finished text — use TerminalOutput.
   * @related terminal-frame, terminal-output
   */
  export type {
    TerminalGeometry,
    TerminalOutputListener,
    TerminalProps,
    TerminalRendererController,
    TerminalRendererFailure,
    TerminalRendererFailurePhase,
    TerminalState,
  } from './terminal.types.ts';
</script>

<script lang="ts">
  import {
    Button,
    Modal,
    TerminalFrame,
    Textarea,
    VisuallyHidden,
    useAnnouncer,
  } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { detectInputPlatform } from '../../input/input-platform.ts';
  import type { InputSettings } from '../../input/input-types.ts';
  import { resolvePasteLimit, type PasteReview } from '../../input/paste-review.ts';
  import { createRefusalAnnouncer } from '../../input/refusal-announcement.ts';
  import { createTerminalInput, type TerminalInput } from '../../input/terminal-input.ts';
  import { createTerminalAttachment, type AttachmentSettings } from './terminal-attachment.ts';
  import { engineLoader } from './terminal-engine-loader.ts';
  import { acceptsInput, isErrorState, mountsEngine, ownsGrid } from './terminal-state.ts';
  import {
    TERMINAL_FRAME_STATUS,
    TERMINAL_STATE_MESSAGE,
    type TerminalProps,
    type TerminalRendererFailure,
    type TerminalState,
  } from './terminal.types.ts';

  let {
    title,
    state: sessionState = 'empty',
    error,
    onRecoveryRequest,
    controller,
    onGeometryChange,
    ownerGeometry,
    ariaLabel = 'Terminal',
    announceOutput = false,
    onLinkActivate,
    onTitleChange,
    maximumPasteBytes,
    onInputRefused,
    class: customClassName,
    ...rest
  }: TerminalProps = $props();

  // Key capture and the paste review belong to the input binding that is live now. They are shown
  // here and held there; a session or engine change disposes the binding, which ends both.
  let input = $state.raw<TerminalInput>();
  let captured = $state(false);
  let reviewOpen = $state(false);
  let displayedReview = $state.raw<PasteReview>();
  const announcer = useAnnouncer();
  const refusalAnnouncer = createRefusalAnnouncer(announcer.announce);
  const reviewId = $props.id();
  const captureControlId = `${reviewId}-capture`;

  // A failure the renderer found itself. It outranks the state the host passed in: the engine is
  // gone, so no other state can be shown truthfully, and nothing is silently reset or replaced.
  // The failure is remembered with the controller it happened to: that controller was revoked by
  // the failure, so the failure ends when the host supplies another defined one, and never before.
  let failed = $state.raw<{ failure: TerminalRendererFailure; controller: typeof controller }>();
  let ready = $state(false);

  // A failure tied to a controller outlives that controller being cleared: nothing was replaced,
  // so the host has not recovered. Only a different, defined controller ends it.
  const replaced = $derived(
    failed !== undefined && controller !== undefined && controller !== failed.controller,
  );
  const failure = $derived(failed !== undefined && !replaced ? failed.failure : undefined);

  // Forget the failure for good once it was replaced, so bringing the old controller back later
  // cannot revive it.
  $effect(() => {
    if (replaced) failed = undefined;
  });
  const effectiveState: TerminalState = $derived(
    failure === undefined ? sessionState : 'engine-load-failed',
  );
  const showEngine = $derived(mountsEngine(effectiveState));
  // Until the engine is mounted the viewport is inert and says so; an error or the absence of a
  // session says that instead, so a refusal never flashes as "loading".
  const message = $derived(
    !ready && showEngine && !isErrorState(effectiveState)
      ? TERMINAL_STATE_MESSAGE.loading
      : TERMINAL_STATE_MESSAGE[effectiveState],
  );
  const className = $derived(['cinder-terminal', customClassName].filter(Boolean).join(' '));

  // The frame's own dimension estimate is deliberately not connected: the engine's measured cell
  // geometry is the only resize authority, so `onDimensionsChange` is never passed.
  const frameProps = $derived({
    ...rest,
    class: className,
    title,
    status: TERMINAL_FRAME_STATUS[effectiveState],
    // The coarse chip cannot tell writable from read-only from backpressured, so the detailed
    // message below is the one live status (experience.md: backpressured is announced once per
    // transition into the state) and the chip stays visible but quiet.
    announceStatus: false,
    ...(error === undefined ? {} : { error }),
    ...(onRecoveryRequest === undefined ? {} : { onReloadRequest: retry }),
  });

  function readSettings(): AttachmentSettings {
    return {
      readOnly: !acceptsInput(effectiveState),
      ownsGrid: ownsGrid(effectiveState),
      ownerGeometry,
      announceOutput,
      ariaLabel,
      activateLink: onLinkActivate,
    };
  }

  function readInputSettings(): InputSettings {
    return {
      writable: acceptsInput(effectiveState),
      maximumPasteBytes: resolvePasteLimit(maximumPasteBytes),
      platform: detectInputPlatform(),
    };
  }

  // The live attachment, for pushing settings that change without remounting the engine. A plain
  // variable: nothing renders from it.
  let live: ReturnType<typeof createTerminalAttachment> | undefined;

  $effect(() => {
    // Track every setting the engine mirrors; the attachment re-reads them itself. The class and
    // inline style are styling inputs too: they can change the tokens the engine colors resolve to.
    readSettings();
    void customClassName;
    void rest.style;
    live?.refresh();
  });

  // A refusal announced before the state changed is news again if it recurs after it.
  $effect(() => {
    void effectiveState;
    refusalAnnouncer.reset();
  });

  // These states say the process is gone, so no output will finish a held unicode prefix. The
  // engine can load after the state ended, and replay what the controller buffered while it did,
  // so the effect also runs when the engine becomes ready: the earlier call found no engine.
  $effect(() => {
    if (!ready) return;
    if (effectiveState === 'exited' || effectiveState === 'disconnected') live?.finishOutput();
  });

  /**
   * Mounts the engine into `host` on the client and releases everything on destroy and when the
   * controller is replaced. Attachments never run on the server, so SSR emits no engine DOM,
   * editable element, subscription, or process. Only the controller is tracked: every other prop
   * reaches the live engine through `refresh`.
   */
  function attachEngine(host: HTMLElement): () => void {
    const borrowed = controller;
    const attachment = untrack(() =>
      createTerminalAttachment({
        host,
        controller: borrowed,
        loadEngine: () => engineLoader.load(),
        readSettings,
        onReady: () => {
          ready = true;
        },
        onGeometry: (geometry) => onGeometryChange?.(geometry),
        onFailure: (next) => {
          failed = { failure: next, controller: borrowed };
        },
        onTitle: (next) => onTitleChange?.(next),
        bindEngine: (engine) => bindInput(engine, host, borrowed),
      }),
    );
    live = attachment;
    return () => {
      attachment.dispose();
      if (live === attachment) live = undefined;
      ready = false;
    };
  }

  /**
   * Binds the session's input to the mounted engine. The binding is made for this controller and
   * this engine only: when either is replaced the attachment disposes it, and nothing it was
   * listening to can send to the session that replaced it.
   */
  function bindInput(
    engine: Parameters<typeof createTerminalInput>[0]['engine'],
    host: HTMLElement,
    borrowed: typeof controller,
  ) {
    const binding = createTerminalInput({
      engine,
      host,
      controller: borrowed?.input,
      readSettings: readInputSettings,
      isCaptureControl: (node) => node instanceof Element && node.id === captureControlId,
      onCaptureChange: (next) => {
        captured = next;
        announcer.announce(next ? 'Terminal key capture on' : 'Terminal key capture off');
      },
      onReview: (next) => {
        if (next !== undefined) displayedReview = next;
        reviewOpen = next !== undefined;
      },
      onRefused: (refusal) => {
        refusalAnnouncer.refused(refusal);
        onInputRefused?.(refusal);
      },
    });
    input = binding;
    return {
      refresh: binding.refresh,
      dispose() {
        binding.dispose();
        if (input === binding) input = undefined;
      },
    };
  }

  function toggleCapture(): void {
    if (captured) input?.release();
    else input?.capture();
  }

  // Recovery is the host's: a renderer failure revoked the controller and cleaned it up, so
  // remounting against it would revive a dead session. The host answers by supplying a new
  // controller or session. The one exception is a failure with no controller, where nothing was
  // revoked, so the engine can be loaded again once the host has been told. That holds for both
  // recovery controls: this component's Retry and the frame's Reload both come through here.
  function retry(): void {
    onRecoveryRequest?.();
    if (failed !== undefined && controller === undefined) failed = undefined;
  }
</script>

<TerminalFrame {...frameProps}>
  <div class="cinder-terminal__body" data-state={effectiveState}>
    <p class="cinder-terminal__message" role="status" aria-atomic="true">{message}</p>
    {#if showEngine}
      <div
        class="cinder-terminal__viewport"
        data-grid={ownsGrid(effectiveState) ? 'fitted' : 'owner'}
        inert={!ready}
        {@attach attachEngine}
      ></div>
    {/if}
    <!-- The frame renders Reload for a non-empty error and a handler, so this control exists only
         when that one does not: exactly one recovery control in every state. -->
    {#if effectiveState === 'engine-load-failed' && onRecoveryRequest !== undefined && !error}
      <div class="cinder-terminal__actions">
        <Button label="Retry" size="sm" onclick={retry} />
      </div>
    {:else if effectiveState === 'writable'}
      <div class="cinder-terminal__actions">
        <Button
          id={captureControlId}
          label="Capture terminal keys"
          size="sm"
          aria-pressed={captured}
          onclick={toggleCapture}
          onfocusout={(event) => input?.focusLeft(event.relatedTarget)}
        />
        <Button label="Interrupt" size="sm" onclick={() => input?.interrupt()} />
      </div>
    {/if}
    <VisuallyHidden as="div" aria-live="polite" aria-atomic="true">
      {announcer.message}
    </VisuallyHidden>
  </div>
</TerminalFrame>

<Modal
  bind:open={reviewOpen}
  title={displayedReview?.kind === 'rejected' ? 'Paste is too large' : 'Review paste'}
  onDismiss={() => input?.cancelPaste()}
  onExitComplete={() => {
    // The pasted text may be a secret; it is not kept once the review has gone.
    displayedReview = undefined;
    // The dialog took focus and with it key capture; the terminal gets both back.
    input?.resumeCapture();
  }}
>
  {#if displayedReview?.kind === 'confirm'}
    <p class="cinder-terminal__review-summary">
      {`${displayedReview.lines} ${displayedReview.lines === 1 ? 'line' : 'lines'}, ${displayedReview.bytes} of ${displayedReview.maximumBytes} bytes.`}
    </p>
    {#if displayedReview.endsWithNewline}
      <p>Ends with a newline, so the last line runs as soon as it is pasted.</p>
    {/if}
    {#if displayedReview.controlCount > 0}
      <p>
        {`Contains ${displayedReview.controlCount} control ${displayedReview.controlCount === 1 ? 'character' : 'characters'}.`}
      </p>
    {/if}
    {#if displayedReview.containsPasteTerminator}
      <p>Contains the bracketed paste terminator, which ends a protected paste early.</p>
    {/if}
    <Textarea
      id={`${reviewId}-preview`}
      label="Paste preview, with line breaks and control characters shown"
      value={displayedReview.visibleText}
      readonly
      rows={8}
      variant="code"
    />
  {:else if displayedReview?.kind === 'rejected'}
    <p>
      {`This paste is ${displayedReview.bytes} bytes and the limit is ${displayedReview.maximumBytes} bytes. Nothing was sent.`}
    </p>
  {/if}
  {#snippet footer()}
    {#if displayedReview?.kind === 'confirm'}
      <Button variant="secondary" autofocus onclick={() => input?.cancelPaste()}>Cancel</Button>
      <Button variant="primary" onclick={() => input?.acceptPaste()}>Paste</Button>
    {:else}
      <Button variant="secondary" autofocus onclick={() => input?.cancelPaste()}>Close</Button>
    {/if}
  {/snippet}
</Modal>
