import { expect, test } from 'bun:test';

import type {
  TerminalRendererController,
  TerminalState,
} from '../components/terminal/terminal.types.ts';
import type { TerminalTransportState } from './transport-types.ts';
import { TerminalWebSocketClient } from './websocket-client.ts';

/**
 * The client is handed to the `Terminal` component as its controller, and its state is passed as the
 * component's `state`. These fail to compile if either stops fitting, so the seam cannot drift.
 */
const client = new TerminalWebSocketClient({
  url: 'wss://terminal.example/terminal?profile=shell',
  sessionId: '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10',
  ticket: 'ticket',
});

function asController(controller: TerminalRendererController): TerminalRendererController {
  return controller;
}

function asState(state: TerminalState): TerminalState {
  return state;
}

test('the client is a renderer controller whose input path is the terminal input controller', () => {
  const controller = asController(client);
  expect(controller.input).toBe(client.input);
  expect(typeof controller.subscribeOutput).toBe('function');
  expect(typeof controller.rendererFailed).toBe('function');
});

test('every state the transport reports is a state the Terminal component renders', () => {
  const states: readonly TerminalTransportState[] = [
    'empty',
    'connecting',
    'writable',
    'read-only',
    'backpressured',
    'exited',
    'disconnected',
    'denied',
    'failed',
    'cleanup-incomplete',
  ];
  expect(states.map(asState)).toEqual([...states]);
  expect(asState(client.state)).toBe('empty');
});
