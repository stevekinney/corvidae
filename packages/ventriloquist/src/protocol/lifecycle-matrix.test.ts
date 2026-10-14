import { describe, expect, test } from 'bun:test';

import { ClientEndpoint } from './client-endpoint.ts';
import {
  expectOk,
  OUTPUT_ONLY_CAPABILITIES,
  PIPE_CAPABILITIES,
  PTY_CAPABILITIES,
  SESSION_IDENTIFIER,
  TOKEN,
} from './endpoint-pair.test-support.ts';
import { encodeFrame } from './frame-codec.ts';
import { HostEndpoint } from './host-endpoint.ts';
import type { Capabilities, OutputChannel, ProtocolMessage, RequestedMode } from './messages.ts';

/**
 * The legality of every message kind, on both endpoints, in every negotiated mode and lifecycle
 * phase. It is one declarative table of rules, each citing `documentation/terminal/contract.md`.
 * One test drives every cell against the real endpoints and fails on any cell that disagrees, so an
 * asymmetry between the endpoints, or a rule one endpoint forgot, is a red cell.
 *
 * - `legal`: the endpoint accepts the frame it receives, or builds the frame it is asked to send.
 * - `refused`: it returns a typed failure instead.
 * - `unsendable`: the kind travels the other way, so the endpoint exposes no method that sends it.
 */

type Column = 'host-send' | 'host-receive' | 'client-send' | 'client-receive';
type Mode = 'pty' | 'pipe' | 'output-only';
type Phase =
  | 'before-hello'
  | 'before-capabilities'
  | 'attached'
  | 'after-process-exit'
  | 'after-attachment-error'
  | 'after-terminate'
  | 'after-cleanup'
  | 'after-close';
type Kind =
  | 'hello'
  | 'capabilities'
  | 'output'
  | 'output:foreign-channel'
  | 'input'
  | 'resize'
  | 'operation-ack'
  | 'operation-failure'
  | 'output-consumed'
  | 'process-exit'
  | 'attachment-error'
  | 'attachment-error:unsupported-runtime'
  | 'terminate'
  | 'cleanup-result';
type Expectation = 'legal' | 'refused' | 'unsendable';

type Cell = {
  readonly kind: Kind;
  readonly column: Column;
  readonly mode: Mode;
  readonly phase: Phase;
  /** Whether an input the receiving host accepted is still unresolved: neither acknowledged nor failed. */
  readonly pending: boolean;
};

type Rule = {
  readonly group: string;
  /** The contract text this rule follows. */
  readonly cite: string;
  readonly applies: (cell: Cell) => boolean;
  readonly expects: (cell: Cell) => Expectation;
};

const COLUMNS: readonly Column[] = ['host-send', 'host-receive', 'client-send', 'client-receive'];
const MODES: readonly Mode[] = ['pty', 'pipe', 'output-only'];
const PHASES: readonly Phase[] = [
  'before-hello',
  'before-capabilities',
  'attached',
  'after-process-exit',
  'after-attachment-error',
  'after-terminate',
  'after-cleanup',
  'after-close',
];
const KINDS: readonly Kind[] = [
  'hello',
  'capabilities',
  'output',
  'output:foreign-channel',
  'input',
  'resize',
  'operation-ack',
  'operation-failure',
  'output-consumed',
  'process-exit',
  'attachment-error',
  'attachment-error:unsupported-runtime',
  'terminate',
  'cleanup-result',
];

const CLIENT_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'hello',
  'input',
  'resize',
  'output-consumed',
  'terminate',
]);
const isClientKind = (kind: Kind) => CLIENT_KINDS.has(kind);
const isStartupError = (kind: Kind) =>
  kind === 'attachment-error' || kind === 'attachment-error:unsupported-runtime';

const is = (phase: Phase, ...phases: Phase[]) => phases.includes(phase);
const verdict = (legal: boolean): Expectation => (legal ? 'legal' : 'refused');
const LIVE: readonly Phase[] = [
  'attached',
  'after-process-exit',
  'after-attachment-error',
  'after-terminate',
];

const RULES: readonly Rule[] = [
  {
    group: 'direction: a kind is only sent by its own side',
    cite: 'Message kinds are `hello` (client to server), `capabilities` (server to client), `output` (server to client), `input` (client to server), `resize` (client to server), `operation-ack` (server to client), ...',
    applies: (c) =>
      (c.column === 'host-send' && isClientKind(c.kind)) ||
      (c.column === 'client-send' && !isClientKind(c.kind)),
    expects: () => 'unsendable',
  },
  {
    group: 'direction: a frame going the wrong way is rejected',
    cite: 'Every application frame ... is rejected if truncated, oversized, malformed, or sent in the wrong direction.',
    applies: (c) =>
      (c.column === 'host-receive' && !isClientKind(c.kind)) ||
      (c.column === 'client-receive' && isClientKind(c.kind)),
    expects: () => 'refused',
  },
  {
    group: 'before hello: only the hello itself',
    cite: 'The handshake payload is `{ version: 1, sessionId, requestedMode, token }`; the response is `{ version: 1, sessionId, attachmentGeneration, capabilities, ... }`. Origin and token authorization happen before generation issuance.',
    applies: (c) => c.phase === 'before-hello',
    expects: (c) =>
      verdict((c.column === 'host-receive' || c.column === 'client-send') && c.kind === 'hello'),
  },
  {
    group:
      'before capabilities: a second hello or any other operation is refused; only a startup outcome may be sent',
    cite: 'Normal output: `hello` produces `hello` bytes tagged with session and generation. / Startup failure: unsupported runtime or missing shell produces `attachment-error` with no process-exit success.',
    applies: (c) => c.phase === 'before-capabilities',
    expects: (c) =>
      verdict(
        (c.column === 'host-send' || c.column === 'client-receive') &&
          (c.kind === 'capabilities' || isStartupError(c.kind)),
      ),
  },
  {
    group: 'after cleanup: nothing more is sent or accepted',
    cite: 'Exit: the host emits PTY EOF or source completion, then the distinct process-exit result when known, revokes the generation, and emits cleanup-result. / Restart is an explicit new session after previous cleanup is complete.',
    applies: (c) => c.phase === 'after-cleanup',
    expects: () => 'refused',
  },
  {
    group: 'after a hard close: the endpoint accepts and sends nothing from its closed side',
    cite: '`malformed-frame` / `frame-too-large`: reject; current generation revoked.',
    applies: (c) => c.phase === 'after-close' && c.column !== 'host-send',
    expects: () => 'refused',
  },
  {
    group: 'a second hello and a second capabilities are duplicates',
    cite: 'Each session has one active attachment and one immutable attachment generation.',
    applies: (c) => c.kind === 'hello' || c.kind === 'capabilities',
    expects: () => 'refused',
  },
  {
    group: 'unsupported-runtime is a startup failure with no attachment',
    cite: '`unsupported-runtime` | server, startup | startup failure; no attachment',
    applies: (c) => c.kind === 'attachment-error:unsupported-runtime',
    expects: () => 'refused',
  },
  {
    group: 'output uses the channels of its mode',
    cite: 'Pipe mode preserves stdout and stderr as separate channels ... PTY mode uses `Bun.spawn({ terminal })`.',
    applies: (c) => c.kind === 'output:foreign-channel',
    expects: () => 'refused',
  },
  {
    group: 'output ends before the process-exit result',
    cite: 'Exit: the host emits PTY EOF or source completion, then the distinct process-exit result when known, revokes the generation, and emits cleanup-result.',
    applies: (c) => c.kind === 'output',
    expects: (c) => verdict(c.phase !== 'after-process-exit'),
  },
  {
    group: 'input and resize need the capability and a live generation',
    cite: 'Invalid input: stale generation or read-only input receives `operation-failure` and is never placed in the FIFO. / Stop revokes authority immediately. / `process-exit` ... revokes the generation. Pipe mode reports no resize.',
    applies: (c) => c.kind === 'input' || c.kind === 'resize',
    expects: (c) =>
      verdict(
        c.phase === 'attached' &&
          (c.kind === 'input' ? c.mode !== 'output-only' : c.mode === 'pty'),
      ),
  },
  {
    group: 'consumed-output acknowledgements continue while the attachment is live',
    cite: 'Normal output: ... then the client may acknowledge consumed output; the host acknowledgement does not alter process state. (Silent on later phases: legal.)',
    applies: (c) => c.kind === 'output-consumed',
    expects: (c) => verdict(is(c.phase, ...LIVE)),
  },
  {
    group:
      'terminate is always available while live, including on an output-only attachment and after a prior terminate',
    cite: 'Stop revokes authority immediately ... / Owned streams are canceled through their reader and owned async iterators receive `return()` when available. / Borrowed sources are unsubscribed but never terminated. (No contract text limits stop by the `kill` capability or by repeating it.)',
    applies: (c) => c.kind === 'terminate',
    expects: (c) => verdict(is(c.phase, ...LIVE)),
  },
  {
    group:
      'an acknowledgement is acceptance into the FIFO; the host never accepts once authority is revoked',
    cite: 'An input acknowledgement means acceptance into that bounded host FIFO. / Stop revokes authority immediately, cancels queued but unsubmitted operations with explicit results. (The client still accepts an acknowledgement the host sent before it saw the client terminate.)',
    applies: (c) => c.kind === 'operation-ack',
    expects: (c) =>
      verdict(
        c.pending &&
          (c.column === 'host-send'
            ? c.phase === 'attached'
            : is(c.phase, 'attached', 'after-terminate')),
      ),
  },
  {
    group: 'a pending operation may always be failed explicitly',
    cite: 'Stop revokes authority immediately, cancels queued but unsubmitted operations with explicit results. / `backend-failed` ... cancel unsent operations; cleanup.',
    applies: (c) => c.kind === 'operation-failure',
    expects: (c) => verdict(c.pending),
  },
  {
    group:
      'process-exit is reported once, never after an attachment error, and never by an output-only source',
    cite: 'A failed connection is not a successful process exit. / Output-only sources ... report source completion rather than inventing exit code zero. / Exit: ... the distinct process-exit result when known, revokes the generation.',
    applies: (c) => c.kind === 'process-exit',
    expects: (c) =>
      verdict(
        c.mode !== 'output-only' && is(c.phase, 'attached', 'after-terminate', 'after-close'),
      ),
  },
  {
    group: 'an attachment error is the one terminal event, and not after a process exit',
    cite: 'A failed connection is not a successful process exit; PTY closure is not a subprocess exit code. / `spawn-failed` ... startup failure; generation revoked. / Exit: ... process-exit ..., revokes the generation, and emits cleanup-result.',
    applies: (c) => c.kind === 'attachment-error',
    expects: (c) => verdict(is(c.phase, 'attached', 'after-terminate', 'after-close')),
  },
  {
    group:
      'cleanup follows cancellation: the host reports it only when no received operation is unresolved',
    cite: 'Stop revokes authority first, cancels unsent operations, terminates owned descendants, closes handles, and reports complete, incomplete, or unknown.',
    applies: (c) => c.kind === 'cleanup-result',
    expects: (c) => verdict(c.column === 'client-receive' || !c.pending),
  },
];

const CAPABILITIES: Record<Mode, Capabilities> = {
  pty: PTY_CAPABILITIES,
  pipe: PIPE_CAPABILITIES,
  'output-only': OUTPUT_ONLY_CAPABILITIES,
};
const REQUESTED: Record<Mode, RequestedMode> = {
  pty: 'interactive',
  pipe: 'interactive',
  'output-only': 'read-only',
};
const CHANNEL: Record<Mode, OutputChannel> = {
  pty: 'pty',
  pipe: 'stdout',
  'output-only': 'stdout',
};
const FOREIGN_CHANNEL: Record<Mode, OutputChannel> = {
  pty: 'stdout',
  pipe: 'pty',
  'output-only': 'stderr',
};

function expectationFor(cell: Cell): Expectation {
  const rule = RULES.find((candidate) => candidate.applies(cell));
  if (rule === undefined) throw new Error(`no rule covers ${cellLabel(cell)}`);
  return rule.expects(cell);
}

function cellLabel(cell: Cell): string {
  return `${cell.column} ${cell.kind} ${cell.mode} ${cell.phase} pending=${cell.pending}`;
}

type Rig = { host: HostEndpoint; client: ClientEndpoint; toHost: number; toClient: number };

/** Reach `phase` through the real endpoints, or `undefined` when no such state exists. */
function build(mode: Mode, phase: Phase, pending: boolean): Rig | undefined {
  if (pending && mode === 'output-only') return undefined;
  if (pending && phase === 'after-cleanup') return undefined;
  if (mode === 'output-only' && phase === 'after-process-exit') return undefined;
  const host = new HostEndpoint();
  const client = new ClientEndpoint({
    sessionId: SESSION_IDENTIFIER,
    requestedMode: REQUESTED[mode],
    token: TOKEN,
  });
  const rig: Rig = { host, client, toHost: 0, toClient: 0 };
  if (phase === 'before-hello') return rig;
  expectOk(host.receive(expectOk(client.hello())));
  if (phase === 'before-capabilities') return rig;
  expectOk(
    client.receive(
      expectOk(host.issueCapabilities({ generation: 1, capabilities: CAPABILITIES[mode] })),
    ),
  );
  const output = expectOk(host.output(CHANNEL[mode], 'x'));
  expectOk(client.receive(output.frame));
  rig.toClient += 1;
  if (pending) {
    expectOk(host.receive(expectOk(client.input('a')).frame));
    rig.toHost += 1;
  }
  switch (phase) {
    case 'after-process-exit':
      expectOk(client.receive(expectOk(host.processExit(0, null)).frame));
      rig.toClient += 1;
      break;
    case 'after-attachment-error':
      expectOk(client.receive(expectOk(host.attachmentError('spawn-failed', 'm')).frame));
      rig.toClient += 1;
      break;
    case 'after-terminate':
      expectOk(host.receive(expectOk(client.terminate()).frame));
      rig.toHost += 1;
      break;
    case 'after-cleanup':
      expectOk(client.receive(expectOk(host.cleanupResult('complete')).frame));
      rig.toClient += 1;
      break;
    case 'after-close':
      host.receive('not json');
      client.receive('not json');
      break;
    default:
      break;
  }
  return rig;
}

/** The frame a peer would send, forged with the sequence the receiving endpoint expects next. */
function forge(cell: Cell, rig: Rig): Uint8Array | string {
  const startup =
    is(cell.phase, 'before-hello', 'before-capabilities') && isStartupError(cell.kind);
  const header = {
    sessionId: SESSION_IDENTIFIER,
    attachmentGeneration: startup ? 0 : 1,
    sequence: startup ? 0 : (cell.column === 'host-receive' ? rig.toHost : rig.toClient) + 1,
  };
  const payload = Uint8Array.of(1);
  const messages: Record<Kind, object> = {
    hello: {
      kind: 'hello',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      requestedMode: REQUESTED[cell.mode],
      token: TOKEN,
    },
    capabilities: {
      kind: 'capabilities',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      attachmentGeneration: 1,
      capabilities: CAPABILITIES[cell.mode],
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
    },
    output: { ...header, kind: 'output', channel: CHANNEL[cell.mode], payload },
    'output:foreign-channel': {
      ...header,
      kind: 'output',
      channel: FOREIGN_CHANNEL[cell.mode],
      payload,
    },
    input: { ...header, kind: 'input', payload },
    resize: { ...header, kind: 'resize', columns: 80, rows: 24 },
    'operation-ack': { ...header, kind: 'operation-ack', operationSequence: 1 },
    'operation-failure': {
      ...header,
      kind: 'operation-failure',
      operationSequence: 1,
      code: 'read-only',
      message: 'm',
    },
    'output-consumed': { ...header, kind: 'output-consumed', consumedBytes: 1 },
    'process-exit': { ...header, kind: 'process-exit', exitCode: 0, signal: null },
    'attachment-error': { ...header, kind: 'attachment-error', code: 'spawn-failed', message: 'm' },
    'attachment-error:unsupported-runtime': {
      ...header,
      kind: 'attachment-error',
      code: 'unsupported-runtime',
      message: 'm',
    },
    terminate: { ...header, kind: 'terminate' },
    'cleanup-result': { ...header, kind: 'cleanup-result', outcome: 'complete' },
  };
  return expectOk(encodeFrame(messages[cell.kind] as ProtocolMessage));
}

/** The method that would send `kind`, on the endpoint that must not have one. */
const SENDER_NAMES: Record<Kind, string> = {
  hello: 'hello',
  capabilities: 'issueCapabilities',
  output: 'output',
  'output:foreign-channel': 'output',
  input: 'input',
  resize: 'resize',
  'operation-ack': 'acknowledgeOperation',
  'operation-failure': 'failOperation',
  'output-consumed': 'consumeOutput',
  'process-exit': 'processExit',
  'attachment-error': 'attachmentError',
  'attachment-error:unsupported-runtime': 'attachmentError',
  terminate: 'terminate',
  'cleanup-result': 'cleanupResult',
};

function observe(cell: Cell, rig: Rig): Expectation {
  const { host, client } = rig;
  switch (cell.column) {
    case 'host-receive':
      return verdict(host.receive(forge(cell, rig)).ok);
    case 'client-receive':
      return verdict(client.receive(forge(cell, rig)).ok);
    case 'host-send': {
      switch (cell.kind) {
        case 'capabilities':
          return verdict(
            host.issueCapabilities({ generation: 1, capabilities: CAPABILITIES[cell.mode] }).ok,
          );
        case 'output':
          return verdict(host.output(CHANNEL[cell.mode], 'x').ok);
        case 'output:foreign-channel':
          return verdict(host.output(FOREIGN_CHANNEL[cell.mode], 'x').ok);
        case 'operation-ack':
          return verdict(host.acknowledgeOperation(1).ok);
        case 'operation-failure':
          return verdict(host.failOperation(1, 'read-only', 'm').ok);
        case 'process-exit':
          return verdict(host.processExit(0, null).ok);
        case 'attachment-error':
          return verdict(host.attachmentError('spawn-failed', 'm').ok);
        case 'attachment-error:unsupported-runtime':
          return verdict(host.attachmentError('unsupported-runtime', 'm').ok);
        case 'cleanup-result':
          return verdict(host.cleanupResult('complete').ok);
        default:
          return typeof (host as never as Record<string, unknown>)[SENDER_NAMES[cell.kind]] ===
            'function'
            ? 'legal'
            : 'unsendable';
      }
    }
    case 'client-send': {
      switch (cell.kind) {
        case 'hello':
          return verdict(client.hello().ok);
        case 'input':
          return verdict(client.input('a').ok);
        case 'resize':
          return verdict(client.resize(80, 24).ok);
        case 'output-consumed':
          return verdict(client.consumeOutput(1).ok);
        case 'terminate':
          return verdict(client.terminate().ok);
        default:
          return typeof (client as never as Record<string, unknown>)[SENDER_NAMES[cell.kind]] ===
            'function'
            ? 'legal'
            : 'unsendable';
      }
    }
  }
}

describe('the lifecycle matrix', () => {
  test('every message kind, direction, mode and phase behaves as the contract says on both endpoints', () => {
    const mismatches: string[] = [];
    let evaluated = 0;
    let unreachable = 0;
    for (const phase of PHASES) {
      for (const mode of MODES) {
        for (const pending of [false, true]) {
          for (const kind of KINDS) {
            for (const column of COLUMNS) {
              const cell: Cell = { kind, column, mode, phase, pending };
              const rig = build(mode, phase, pending);
              if (rig === undefined) {
                unreachable += 1;
                continue;
              }
              evaluated += 1;
              const expected = expectationFor(cell);
              const actual = observe(cell, rig);
              if (actual !== expected) {
                mismatches.push(`${cellLabel(cell)}: expected ${expected}, got ${actual}`);
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(evaluated + unreachable).toBe(
      KINDS.length * COLUMNS.length * MODES.length * PHASES.length * 2,
    );
    expect(evaluated).toBeGreaterThan(2000);
  });

  test('the rules cover every cell exactly once in intent: each rule is used', () => {
    const used = new Set<string>();
    for (const phase of PHASES) {
      for (const mode of MODES) {
        for (const pending of [false, true]) {
          for (const kind of KINDS) {
            for (const column of COLUMNS) {
              const cell: Cell = { kind, column, mode, phase, pending };
              const rule = RULES.find((candidate) => candidate.applies(cell));
              if (rule !== undefined) used.add(rule.group);
            }
          }
        }
      }
    }
    expect([...used].toSorted()).toEqual(RULES.map((rule) => rule.group).toSorted());
  });
});
