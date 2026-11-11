/**
 * The flow of the Connect tools page (`connect-tools.svelte`, COR-2022 board PageConnectTools) as one
 * explicit state machine: a test of the connection, the choice of tools it lists, the connect, and
 * what the page says in each phase.
 *
 * The phases are `idle` (no test has passed for what the form holds), `testing`, `passed`, `failed`
 * (the test did not pass), `connecting`, `slow` (connecting for 15 seconds, row 34z), `connected`
 * and `failed-connect` (row 34b). Beside the phase the state holds two flags that are inputs, not
 * phases: `dirty` (the form differs from the empty one, so leaving asks first, rows 35b and 35f) and
 * `offline` (the server does not answer, so Test connection and Connect are inert, row 35f).
 *
 * {@link connectTransition} is the machine itself: pure, with an exhaustive switch over the events,
 * so each transition is tested on its own. {@link ConnectFlow} wraps it for the page: it sends the
 * request a transition starts, holds the one `AbortController` that Cancel aborts (rows 34a, 34s,
 * 34z), starts the 15 second timer that dispatches `slow`, and keeps the person's choice of tools.
 *
 * Every request carries the number of the attempt that started it, and an answer to an attempt that
 * is no longer current (one Cancel stopped, or one a new test replaced) changes nothing.
 */
import type { ToolSourceChange, ToolSourceProbe } from '../../lib/host-tool-sources.ts';
import {
  startingToolChoices,
  type ToolChoice,
  type ToolSourceFormKind,
  type ToolSourceTransportChoice,
} from '../../lib/tool-source-form.ts';

/** A test that found the source there: it listed its tools, or asked for the sign-in that follows connecting. */
export type PassedProbe = Exclude<ToolSourceProbe, { outcome: 'failed' }>;

/**
 * Why a test did not pass: the source did not answer (`no-answer`, with the host's words, which hold
 * no address or value), or the host refused the request (`refused`). An empty `message` is a refusal
 * the page put under the field the host named.
 */
export type ConnectTestFailure = {
  readonly kind: 'no-answer' | 'refused';
  readonly message: string;
};

/** Where the flow stands. Every phase but `idle` names the request (`signature`) it is about. */
export type ConnectPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'testing';
      readonly attempt: number;
      readonly signature: string;
      /** Whether Connect was pressed, so a test that passes goes on to connect (rows 33n, 34j). */
      readonly thenConnect: boolean;
    }
  | { readonly kind: 'passed'; readonly signature: string; readonly probe: PassedProbe }
  | { readonly kind: 'failed'; readonly signature: string; readonly failure: ConnectTestFailure }
  | {
      readonly kind: 'connecting' | 'slow';
      readonly attempt: number;
      readonly signature: string;
      readonly probe: PassedProbe;
    }
  | {
      readonly kind: 'connected';
      readonly signature: string;
      readonly probe: PassedProbe;
      readonly change: ToolSourceChange;
    }
  | {
      readonly kind: 'failed-connect';
      readonly signature: string;
      readonly probe: PassedProbe;
      /** What the host said, or the empty string when the server stopped answering (row 34b). */
      readonly message: string;
    };

/** The machine's whole state: the phase, and the two flags beside it. */
export type ConnectState = {
  readonly phase: ConnectPhase;
  /** Whether the form differs from the empty one: leaving then asks first (rows 35b, 35f). */
  readonly dirty: boolean;
  /** Whether the server does not answer: Test connection and Connect are inert (row 35f). */
  readonly offline: boolean;
  /** The number of the last request started. An answer to an earlier one changes nothing. */
  readonly attempt: number;
};

/** The page before anything is filled in. */
export const INITIAL_CONNECT_STATE: ConnectState = {
  phase: { kind: 'idle' },
  dirty: false,
  offline: false,
  attempt: 0,
};

/** What can happen to the flow. */
export type ConnectEvent =
  /** The form changed: `signature` is the request it now makes, and `dirty` whether it differs from the empty one. */
  | { readonly type: 'edit'; readonly signature: string; readonly dirty: boolean }
  /** Test connection was pressed. */
  | { readonly type: 'test'; readonly signature: string }
  /** Connect was pressed: it connects after a test that passed, and tests first otherwise (row 33n). */
  | { readonly type: 'connect'; readonly signature: string }
  /** The test of attempt `attempt` answered. */
  | { readonly type: 'tested'; readonly attempt: number; readonly probe: ToolSourceProbe }
  /** The host refused the test of attempt `attempt`. */
  | { readonly type: 'test-refused'; readonly attempt: number; readonly message: string }
  /** The connect of attempt `attempt` has run for 15 seconds (row 34z). */
  | { readonly type: 'slow'; readonly attempt: number }
  /** The connect of attempt `attempt` saved the source. */
  | { readonly type: 'connected'; readonly attempt: number; readonly change: ToolSourceChange }
  /** The connect of attempt `attempt` failed; an empty `message` was put under a field. */
  | { readonly type: 'connect-refused'; readonly attempt: number; readonly message: string }
  /** Cancel stopped the request in flight (rows 34a, 34s, 34z). */
  | { readonly type: 'cancel' }
  /** The server stopped or started answering. */
  | { readonly type: 'connection'; readonly offline: boolean };

/** The signature of the request a phase is about, or `undefined` for `idle`. */
function signatureOf(phase: ConnectPhase): string | undefined {
  return phase.kind === 'idle' ? undefined : phase.signature;
}

/** Starts a test of `signature` as a new attempt. */
function startTest(state: ConnectState, signature: string, thenConnect: boolean): ConnectState {
  const attempt = state.attempt + 1;
  return { ...state, attempt, phase: { kind: 'testing', attempt, signature, thenConnect } };
}

/** Starts a connect of `signature` after a test that passed, as a new attempt. */
function startConnect(state: ConnectState, signature: string, probe: PassedProbe): ConnectState {
  const attempt = state.attempt + 1;
  return { ...state, attempt, phase: { kind: 'connecting', attempt, signature, probe } };
}

/** A form that changed: a result about the request it made before is stale. */
function edited(state: ConnectState, signature: string, dirty: boolean): ConnectState {
  const phase = state.phase;
  const changed = signatureOf(phase) !== undefined && signatureOf(phase) !== signature;
  switch (phase.kind) {
    case 'passed':
    case 'failed':
    case 'failed-connect':
      return { ...state, dirty, phase: changed ? { kind: 'idle' } : phase };
    case 'idle':
    case 'testing':
    case 'connecting':
    case 'slow':
    case 'connected':
      // A request in flight carries its own copy of the form; a connected source is done.
      return { ...state, dirty };
    default:
      return assertNever(phase);
  }
}

/** Connect pressed: connect after a test that passed for this request, and test first otherwise. */
function connectPressed(state: ConnectState, signature: string): ConnectState {
  const phase = state.phase;
  switch (phase.kind) {
    case 'passed':
    case 'failed-connect':
      return phase.signature === signature
        ? startConnect(state, signature, phase.probe)
        : startTest(state, signature, true);
    case 'idle':
    case 'failed':
      return startTest(state, signature, true);
    case 'testing':
      // Connect stays enabled while the test runs, and connects once it passes (row 34j).
      return { ...state, phase: { ...phase, thenConnect: true } };
    case 'connecting':
    case 'slow':
    case 'connected':
      return state;
    default:
      return assertNever(phase);
  }
}

/** Test connection pressed: a new test, unless one or a connect is in flight or the source is connected. */
function testPressed(state: ConnectState, signature: string): ConnectState {
  const phase = state.phase;
  switch (phase.kind) {
    case 'idle':
    case 'passed':
    case 'failed':
    case 'failed-connect':
      return startTest(state, signature, false);
    case 'testing':
    case 'connecting':
    case 'slow':
    case 'connected':
      return state;
    default:
      return assertNever(phase);
  }
}

/** The answer to a test: the source is there, or it is not. A test pressed with Connect goes on to connect. */
function testAnswered(state: ConnectState, attempt: number, probe: ToolSourceProbe): ConnectState {
  const phase = state.phase;
  if (phase.kind !== 'testing' || phase.attempt !== attempt) return state;
  if (probe.outcome === 'failed') {
    return {
      ...state,
      phase: {
        kind: 'failed',
        signature: phase.signature,
        failure: { kind: 'no-answer', message: probe.message },
      },
    };
  }
  return phase.thenConnect
    ? startConnect(state, phase.signature, probe)
    : { ...state, phase: { kind: 'passed', signature: phase.signature, probe } };
}

/** Cancel: a test stopped leaves no result; a connect stopped goes back to the test that passed, with nothing saved. */
function cancelled(state: ConnectState): ConnectState {
  const phase = state.phase;
  switch (phase.kind) {
    case 'testing':
      return { ...state, phase: { kind: 'idle' } };
    case 'connecting':
    case 'slow':
      return {
        ...state,
        phase: { kind: 'passed', signature: phase.signature, probe: phase.probe },
      };
    case 'idle':
    case 'passed':
    case 'failed':
    case 'connected':
    case 'failed-connect':
      return state;
    default:
      return assertNever(phase);
  }
}

/** Whether `phase` is the connect of attempt `attempt`, still in flight. */
function isConnectOf(
  phase: ConnectPhase,
  attempt: number,
): phase is Extract<ConnectPhase, { kind: 'connecting' | 'slow' }> {
  return (phase.kind === 'connecting' || phase.kind === 'slow') && phase.attempt === attempt;
}

/**
 * The state after `event`. Pure: the page's {@link ConnectFlow} sends whatever request the new
 * state starts. While the server does not answer, Test connection and Connect do nothing (row 35f).
 */
export function connectTransition(state: ConnectState, event: ConnectEvent): ConnectState {
  switch (event.type) {
    case 'edit':
      return edited(state, event.signature, event.dirty);
    case 'test':
      return state.offline ? state : testPressed(state, event.signature);
    case 'connect':
      return state.offline ? state : connectPressed(state, event.signature);
    case 'tested':
      return testAnswered(state, event.attempt, event.probe);
    case 'test-refused': {
      const phase = state.phase;
      if (phase.kind !== 'testing' || phase.attempt !== event.attempt) return state;
      return {
        ...state,
        phase: {
          kind: 'failed',
          signature: phase.signature,
          failure: { kind: 'refused', message: event.message },
        },
      };
    }
    case 'slow': {
      const phase = state.phase;
      if (phase.kind !== 'connecting' || phase.attempt !== event.attempt) return state;
      return { ...state, phase: { ...phase, kind: 'slow' } };
    }
    case 'connected': {
      const phase = state.phase;
      if (!isConnectOf(phase, event.attempt)) return state;
      return {
        ...state,
        // The source is saved: the page has nothing left to lose.
        dirty: false,
        phase: {
          kind: 'connected',
          signature: phase.signature,
          probe: phase.probe,
          change: event.change,
        },
      };
    }
    case 'connect-refused': {
      const phase = state.phase;
      if (!isConnectOf(phase, event.attempt)) return state;
      // A refusal put under a field (a name another tab took) leaves the passed test as it was.
      return {
        ...state,
        phase:
          event.message === ''
            ? { kind: 'passed', signature: phase.signature, probe: phase.probe }
            : {
                kind: 'failed-connect',
                signature: phase.signature,
                probe: phase.probe,
                message: event.message,
              },
      };
    }
    case 'cancel':
      return cancelled(state);
    case 'connection':
      return { ...state, offline: event.offline };
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled connect flow value: ${JSON.stringify(value)}`);
}

/** Whether a request is in flight: a test, or a connect. */
export function isConnectBusy(phase: ConnectPhase): boolean {
  return phase.kind === 'testing' || phase.kind === 'connecting' || phase.kind === 'slow';
}

/** The test that passed for the request the form makes now, or `undefined`. */
export function passedProbeOf(phase: ConnectPhase): PassedProbe | undefined {
  switch (phase.kind) {
    case 'passed':
    case 'connecting':
    case 'slow':
    case 'connected':
    case 'failed-connect':
      return phase.probe;
    case 'idle':
    case 'testing':
    case 'failed':
      return undefined;
    default:
      return assertNever(phase);
  }
}

/** What the footer's line says (rows 33n, 33r, 33y, 34c, 34j, 34x, 34z, 35f). */
export type ConnectFooterLine =
  | { readonly kind: 'offline' }
  | { readonly kind: 'connecting'; readonly slow: boolean }
  | { readonly kind: 'joins'; readonly count: number }
  | { readonly kind: 'tests-first' }
  | { readonly kind: 'choose-first' }
  | { readonly kind: 'none' };

/**
 * The footer's line for `state`: Connect is off while the server does not answer; it says it is
 * connecting while it does; once tools are listed it says how many join Capabilities; a source
 * already connected at the address, a test in flight, and a local command say Connect tests first;
 * and before a test has passed it says to test to choose tools. `listed` is whether Choose tools
 * lists tools to choose from (an MCP server's test, or an OpenAPI spec that was read).
 */
export function connectFooterLine(
  state: ConnectState,
  context: {
    readonly listed: boolean;
    readonly chosen: number;
    readonly transport: ToolSourceTransportChoice;
    readonly kind: ToolSourceFormKind;
    readonly duplicate: boolean;
  },
): ConnectFooterLine {
  const phase = state.phase;
  if (state.offline) return { kind: 'offline' };
  if (phase.kind === 'connecting' || phase.kind === 'slow') {
    return { kind: 'connecting', slow: phase.kind === 'slow' };
  }
  if (phase.kind === 'connected') return { kind: 'none' };
  if (context.duplicate || phase.kind === 'testing') return { kind: 'tests-first' };
  if (context.listed) return { kind: 'joins', count: context.chosen };
  if (passedProbeOf(phase)?.outcome === 'needs-authorization') return { kind: 'none' };
  if (context.kind === 'mcp' && context.transport === 'stdio') return { kind: 'tests-first' };
  return { kind: 'choose-first' };
}

/**
 * The address a saved source is known by, as the host cuts it (`tool-source-manager.ts`): the
 * origin and path, with no query or fragment. `undefined` for text that is not a URL.
 */
export function sourceAddressOf(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Where a test goes, for the note beside Test connection while it runs (row 34i): the host of the
 * address, or `undefined` for text that is not a URL.
 */
export function contactedHost(value: string): string | undefined {
  try {
    return new URL(value.trim()).host || undefined;
  } catch {
    return undefined;
  }
}

/** How long Connect runs before the footer says it is taking longer than usual (row 34z). Tests set it lower. */
export const connectTiming = { slowAfterMilliseconds: 15_000 };

/** What the page hands the flow for one request: how to test it and how to connect it. */
export type ConnectRequest = {
  /** The request the form makes, as a string: a test is kept only while the form still makes it. */
  readonly signature: string;
  /** Contacts the source with what the form holds; aborted by Cancel. */
  readonly probe: (signal: AbortSignal) => Promise<ToolSourceProbe>;
  /** Saves the source with the person's choice of tools; aborted by Cancel. */
  readonly connect: (
    choices: Readonly<Record<string, ToolChoice>>,
    signal: AbortSignal,
  ) => Promise<ToolSourceChange>;
  /** Which kind of source, so a test that lists an MCP server's tools seeds Choose tools. */
  readonly kind: ToolSourceFormKind;
};

/** A tool Choose tools offers: its own name and the risk it declares. */
export type ChoosableTool = { readonly tool: string; readonly tier: string | null };

/**
 * The Connect tools page's flow: {@link connectTransition} with the requests it starts. `describe`
 * turns a failure of the test or of the connect (`stage`) into the words for the whole request, or
 * the empty string when the page put it under the field the host named.
 */
export class ConnectFlow {
  /** The machine's state. */
  state = $state.raw<ConnectState>(INITIAL_CONNECT_STATE);
  /** The person's choice for each tool Choose tools lists, by the tool's own name (rows 33i, 34c). */
  choices = $state.raw<Readonly<Record<string, ToolChoice>>>({});
  readonly #describe: (error: unknown, stage: 'test' | 'connect') => string;
  #request: ConnectRequest | undefined;
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The tools the choices were seeded from, so a test that lists the same tools keeps them. */
  #seeded = '';

  constructor(describe: (error: unknown, stage: 'test' | 'connect') => string) {
    this.#describe = describe;
  }

  /** The phase the flow is in. */
  get phase(): ConnectPhase {
    return this.state.phase;
  }

  /** Whether a test or a connect is in flight. */
  get busy(): boolean {
    return isConnectBusy(this.state.phase);
  }

  /** The form changed. */
  edit(signature: string, dirty: boolean): void {
    this.#dispatch({ type: 'edit', signature, dirty });
  }

  /** The server stopped or started answering. */
  setOffline(offline: boolean): void {
    if (offline !== this.state.offline) this.#dispatch({ type: 'connection', offline });
  }

  /** Test connection: contacts the source with what the form holds. */
  test(request: ConnectRequest): void {
    this.#request = request;
    this.#dispatch({ type: 'test', signature: request.signature });
  }

  /** Connect, or Try again after a connect that failed: tests first when no test passed for the request. */
  connect(request: ConnectRequest): void {
    this.#request = request;
    this.#dispatch({ type: 'connect', signature: request.signature });
  }

  /** Cancel: stops the request in flight and saves nothing. Answers whether there was one to stop. */
  cancel(): boolean {
    const stopped = this.busy;
    this.#stop();
    this.#dispatch({ type: 'cancel' });
    return stopped;
  }

  /**
   * Seeds Choose tools from the tools a source lists, each at its starting choice
   * (`startingToolChoices`). The same tools listed again keep the choices made (row 34c).
   */
  seed(kind: ToolSourceFormKind, tools: readonly ChoosableTool[]): void {
    const key = `${kind}\n${tools
      .map(({ tool }) => tool)
      .toSorted()
      .join('\n')}`;
    if (key === this.#seeded) return;
    this.#seeded = key;
    this.choices = startingToolChoices(kind, tools);
  }

  /** Changes one tool's choice. */
  choose(tool: string, change: Partial<ToolChoice>): void {
    const current = Object.hasOwn(this.choices, tool) ? this.choices[tool] : undefined;
    if (current === undefined) return;
    this.choices = { ...this.choices, [tool]: { ...current, ...change } };
  }

  /** Turns every tool in `tools` on or off: Select all (row 33w). */
  chooseAll(tools: readonly string[], on: boolean): void {
    const next = { ...this.choices };
    for (const tool of tools) {
      const current = Object.hasOwn(next, tool) ? next[tool] : undefined;
      if (current !== undefined) next[tool] = { ...current, on };
    }
    this.choices = next;
  }

  /** Stops whatever is in flight; the page calls it when it unmounts. */
  dispose(): void {
    this.#stop();
  }

  #stop(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #dispatch(event: ConnectEvent): void {
    const before = this.state;
    this.state = connectTransition(before, event);
    if (this.state.attempt !== before.attempt) this.#start();
  }

  /** Sends the request the new phase stands for: a test, or a connect with the choices made. */
  #start(): void {
    this.#stop();
    const request = this.#request;
    const phase = this.state.phase;
    if (request === undefined) return;
    const controller = new AbortController();
    this.#controller = controller;
    if (phase.kind === 'testing') {
      const attempt = phase.attempt;
      request.probe(controller.signal).then(
        (probe) => {
          if (controller.signal.aborted) return;
          if (probe.outcome === 'listed' && request.kind === 'mcp') this.seed('mcp', probe.tools);
          this.#dispatch({ type: 'tested', attempt, probe });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          this.#dispatch({
            type: 'test-refused',
            attempt,
            message: this.#describe(error, 'test'),
          });
        },
      );
      return;
    }
    if (phase.kind === 'connecting') {
      const attempt = phase.attempt;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#dispatch({ type: 'slow', attempt });
      }, connectTiming.slowAfterMilliseconds);
      request.connect(this.choices, controller.signal).then(
        (change) => {
          if (controller.signal.aborted) return;
          this.#stop();
          this.#dispatch({ type: 'connected', attempt, change });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          this.#stop();
          this.#dispatch({
            type: 'connect-refused',
            attempt,
            message: this.#describe(error, 'connect'),
          });
        },
      );
    }
  }
}
