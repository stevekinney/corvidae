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
  import { Button, TerminalFrame } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

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
    class: customClassName,
    ...rest
  }: TerminalProps = $props();

  // A failure the renderer found itself. It outranks the state the host passed in: the engine is
  // gone, so no other state can be shown truthfully, and nothing is silently reset or replaced.
  // The failure is remembered with the controller it happened to: that controller was revoked by
  // the failure, so the failure ends when the host supplies another one, and never before.
  let failed = $state.raw<{ failure: TerminalRendererFailure; controller: typeof controller }>();
  let ready = $state(false);

  const failure = $derived(
    failed !== undefined && failed.controller === controller ? failed.failure : undefined,
  );
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
    ...(error === undefined ? {} : { error }),
    ...(onRecoveryRequest === undefined ? {} : { onReloadRequest: onRecoveryRequest }),
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

  // These states say the process is gone, so no output will finish a held unicode prefix. The
  // engine can load after the state ended, and replay what the controller buffered while it did,
  // so the effect also runs when the engine becomes ready: the earlier call found no engine.
  $effect(() => {
    if (!ready) return;
    if (effectiveState === 'exited' || effectiveState === 'disconnected') live?.finishOutput();
  });

  // `TerminalFrame` renders its coarse status chip as a polite live region and offers no way to
  // turn that off. The chip cannot tell writable from read-only from backpressured, so a change
  // among them would announce nothing. The detailed message below is the one live status instead
  // (experience.md: backpressured is announced once per transition into the state), and this
  // removes the chip's role so the frame never holds a second one. Its text stays visible.
  function quietFrameStatus(node: HTMLElement): void {
    node
      .closest('.cinder-terminal-frame')
      ?.querySelector('.cinder-terminal-frame__status')
      ?.removeAttribute('role');
  }

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
      }),
    );
    live = attachment;
    return () => {
      attachment.dispose();
      if (live === attachment) live = undefined;
      ready = false;
    };
  }

  // Recovery is the host's: a renderer failure revoked the controller and cleaned it up, so
  // remounting against it would revive a dead session. The host answers by supplying a new
  // controller or session. The one exception is a failure with no controller, where nothing was
  // revoked, so the engine can be loaded again once the host has been told.
  function retry(): void {
    onRecoveryRequest?.();
    if (failed !== undefined && failed.controller === undefined) failed = undefined;
  }
</script>

<TerminalFrame {...frameProps}>
  <div class="cinder-terminal__body" data-state={effectiveState} {@attach quietFrameStatus}>
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
        <Button label="Capture terminal keys" size="sm" />
      </div>
    {/if}
  </div>
</TerminalFrame>
