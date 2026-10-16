<script lang="ts">
  import { Terminal } from '@lostgradient/terminal';
  import { hydrate, tick, unmount as unmountComponent } from 'svelte';

  import type { LabEvents, LabProps, TerminalLab } from './terminal/lab-types.ts';
  import { TRANSCRIPT } from './terminal/programs.ts';
  import {
    LAB_FIXTURE,
    VISUAL_SCENARIOS,
    type FixtureScenario,
    type FixtureStep,
  } from './terminal/scenarios.ts';
  import { createScriptedSession, type ScriptedSession } from './terminal/scripted-session.ts';

  /**
   * One host for every terminal browser fixture. The URL picks the scenario (`fixture`) and the
   * behavioral knobs; `window.terminalLab` is the spec's handle on the scripted session. Nothing
   * here reaches the component's engine: a resting baseline and a behavioral spec both drive the
   * component only through its props, its controller, and the page.
   */
  const query = new URLSearchParams(window.location.search);
  const fixtureName = query.get('fixture') ?? LAB_FIXTURE;
  const scenario: FixtureScenario =
    fixtureName in VISUAL_SCENARIOS
      ? VISUAL_SCENARIOS[fixtureName as keyof typeof VISUAL_SCENARIOS]
      : { state: 'writable', output: TRANSCRIPT };
  const flag = (name: string, fallback = false): boolean => {
    const value = query.get(name);
    return value === null ? fallback : value !== '0';
  };
  const number = (name: string): number | undefined => {
    const value = query.get(name);
    return value === null || value === '' ? undefined : Number(value);
  };

  const gate = flag('gate', true);
  const probes = flag('probes');
  const hydrating = flag('hydrate');
  const stageHeight = query.get('height') ?? '28rem';
  // A host handler that throws, to prove the component fails closed instead of carrying on.
  const throwOn = query.get('throwOn');

  const sessionOptions = () => {
    const maxFrameBytes = number('frame');
    const maxQueuedOperations = number('queue');
    return {
      ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
      ...(maxQueuedOperations === undefined ? {} : { maxQueuedOperations }),
    };
  };
  const seed = (): ScriptedSession => {
    const next = createScriptedSession(sessionOptions());
    if (scenario.output !== undefined && !flag('quiet')) next.write(scenario.output);
    return next;
  };

  let session = $state.raw<ScriptedSession>(seed());
  const props = $state<LabProps>({
    title: query.get('title') ?? 'Build shell',
    state: (query.get('state') as LabProps['state'] | null) ?? scenario.state,
    error: query.get('error') ?? undefined,
    mouseReporting: flag('mouse', scenario.mouseReporting ?? false),
    announceOutput: flag('announce'),
    ariaLabel: query.get('label') ?? 'Terminal',
    links: flag('links'),
    recovery: flag('recovery', scenario.recovery ?? false),
    actions: flag('actions', scenario.actions ?? false),
    cleanupPending: flag('cleanup', scenario.cleanupPending ?? false),
    ownerGeometry: undefined,
    maximumPasteBytes: number('maxPaste'),
  });
  const events: LabEvents = {
    geometry: [],
    refusals: [],
    inspection: [],
    titles: [],
    links: [],
    recoveryRequests: 0,
    actions: [],
  };
  const lifecycle = { mounts: 0, unmounts: 0 };
  let mounted = $state(true);
  let generation = $state(0);
  let stage: HTMLElement | undefined = $state();
  let hydrationTarget: HTMLElement | undefined = $state();
  let revealed = $state(!gate);
  let stageReady = $state(false);
  let firstStepDone = false;
  const readyWaiters: Array<() => void> = [];

  const frames = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };

  /** True once the terminal shows what its state calls for: a ready engine, or none to wait for. */
  const showing = (): boolean => {
    const body = stage?.querySelector<HTMLElement>('.cinder-terminal__body');
    if (body === null || body === undefined) return false;
    const viewport = body.querySelector('.cinder-terminal__viewport');
    return viewport === null || !viewport.hasAttribute('inert');
  };

  const button = (label: string): HTMLButtonElement | undefined =>
    [...(stage?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  const untilDialog = async (): Promise<void> => {
    while (document.querySelector('[role="dialog"], dialog[open]') === null) await frames(1);
    await frames(2);
  };

  const dispatchPaste = (text: string): void => {
    const target = stage?.querySelector('textarea');
    if (target === null || target === undefined)
      throw new Error('No terminal input to paste into.');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    });
    target.dispatchEvent(event);
  };

  const runStep = async (step: FixtureStep): Promise<void> => {
    if (step === 'capture') {
      button('Capture terminal keys')?.click();
      // The shared sweep blurs the focused element once the page is visible, which releases
      // capture as it should. Capture again after that one blur so the resting state is the one
      // the fixture names; a reader's own blur afterwards behaves normally.
      document.addEventListener(
        'focusout',
        () => {
          requestAnimationFrame(() => {
            const capture = button('Capture terminal keys');
            if (capture?.getAttribute('aria-pressed') !== 'true') capture?.click();
          });
        },
        { once: true },
      );
    } else if (step === 'paste-review') {
      dispatchPaste('echo one\necho two\u001b[31m\n');
      await untilDialog();
    } else {
      button('Export')?.click();
      await untilDialog();
      if (step === 'export-stale') {
        session.write('output after the snapshot\r\n');
        await session.settled();
        await frames(2);
      }
    }
    await frames(2);
  };

  /** Wait for the first paint of a mounted terminal, run the scenario's step, then show the stage. */
  async function settle(): Promise<void> {
    const mine = generation;
    stageReady = false;
    while (!showing()) await frames(1);
    if (mine !== generation) return;
    await session.settled();
    await frames(3);
    // Every step, the focus-taking capture step included, runs before the stage is revealed or
    // marked ready, so nothing that waits for the stage (the shared sweep, its axe check) can start
    // on a state the fixture has not reached. The host below stays visible, so it can take focus.
    if (!firstStepDone && scenario.step !== undefined) {
      firstStepDone = true;
      await runStep(scenario.step);
    }
    if (mine !== generation) return;
    revealed = true;
    // The page's reduced-motion rule gives visibility a transition of a few microseconds, so the
    // stage's children are still hidden for the first frame after the reveal.
    await frames(3);
    if (mine !== generation) return;
    stageReady = true;
    for (const resolve of readyWaiters.splice(0)) resolve();
  }

  $effect(() => {
    void generation;
    if (!mounted) {
      stageReady = false;
      return;
    }
    void tick().then(settle);
  });

  // Hydration: the spec supplies the server markup, the host adopts it and does nothing else.
  $effect(() => {
    if (!hydrating || hydrationTarget === undefined) return;
    const markup = (window as { terminalServerMarkup?: string }).terminalServerMarkup;
    if (markup === undefined) throw new Error('Hydration needs window.terminalServerMarkup.');
    hydrationTarget.innerHTML = markup;
    const adopted = hydrate(Terminal, {
      target: hydrationTarget,
      props: {
        title: props.title,
        state: props.state,
        controller: session,
        onGeometryChange: (geometry) => events.geometry.push(geometry),
      },
    });
    lifecycle.mounts += 1;
    return () => {
      void unmountComponent(adopted);
      lifecycle.unmounts += 1;
    };
  });

  // Props the component leaves out rather than receives as `undefined`.
  // With `flow`, the handlers answer as a host does: by changing the state the reader sees.
  const flow = flag('flow');
  const act = (label: string, next?: LabProps['state']) => () => {
    events.actions.push(label);
    if (flow && next !== undefined) props.state = next;
  };
  const optional = $derived({
    ...(props.error === undefined ? {} : { error: props.error }),
    ...(props.ownerGeometry === undefined ? {} : { ownerGeometry: props.ownerGeometry }),
    ...(props.maximumPasteBytes === undefined
      ? {}
      : { maximumPasteBytes: props.maximumPasteBytes }),
    ...(props.actions
      ? {
          onNewSession: act('New session', 'connecting'),
          onTryAgain: act('Try again', 'connecting'),
          onRetry: act('Retry', 'connecting'),
          onCheckCleanup: act('Check cleanup'),
          onCancel: act('Cancel', 'empty'),
        }
      : {}),
    ...(props.links ? { onLinkActivate: (url: string) => void events.links.push(url) } : {}),
    ...(props.recovery ? { onRecoveryRequest: () => void (events.recoveryRequests += 1) } : {}),
  });

  const lab: TerminalLab = {
    get session() {
      return session;
    },
    props,
    events,
    lifecycle,
    setProps(next) {
      Object.assign(props, next);
    },
    newSession() {
      session = createScriptedSession(sessionOptions());
      return session;
    },
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
    },
    remount() {
      generation += 1;
      mounted = true;
    },
    ready() {
      return stageReady ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve));
    },
  };
  window.terminalLab = lab;
  $effect(() => () => {
    delete window.terminalLab;
  });
</script>

<div
  id="terminal-stage"
  class="terminal-stage"
  style:visibility={revealed ? 'visible' : 'hidden'}
  data-terminal-ready={stageReady ? 'true' : 'false'}
  data-terminal-fixture={fixtureName}
  bind:this={stage}
>
  {#if probes}
    <p>
      <label>Before the terminal <input id="before-terminal" type="text" /></label>
    </p>
  {/if}
  <div class="terminal-host" style:height={stageHeight} style:visibility="visible">
    {#if hydrating}
      <div bind:this={hydrationTarget} style="height: 100%;"></div>
    {:else if mounted}
      {#key generation}
        <Terminal
          title={props.title}
          state={props.state}
          controller={session}
          mouseReporting={props.mouseReporting}
          cleanupPending={props.cleanupPending}
          announceOutput={props.announceOutput}
          ariaLabel={props.ariaLabel}
          onGeometryChange={(geometry) => {
            events.geometry.push(geometry);
            if (throwOn === 'geometry') throw new Error('scripted geometry handler failure');
          }}
          onInputRefused={(refusal) => events.refusals.push(refusal)}
          onInspectionEvent={(event) => events.inspection.push(event)}
          onTitleChange={(title) => {
            events.titles.push(title);
            if (throwOn === 'title') throw new Error('scripted title handler failure');
          }}
          {...optional}
        />
      {/key}
    {/if}
  </div>
  {#if probes}
    <p><a id="after-terminal" href="#after">After the terminal</a></p>
  {/if}
</div>

<style>
  .terminal-stage {
    max-inline-size: 100%;
  }
  .terminal-host {
    min-inline-size: 0;
  }
</style>
