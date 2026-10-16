import type {
  TerminalRendererController,
  TerminalRendererFailure,
  TerminalState,
  TerminalTransportState,
  TerminalWebSocketClient,
} from '@lostgradient/terminal';
import type { Capabilities, OutputChannel } from '@lostgradient/ventriloquist';

/**
 * The state a `Terminal` shows for what the transport reports. The transport's names are a subset
 * of the terminal's; the one refinement is a connection that was granted no input, which is
 * read-only whether the server said so (a read-only grant) or the process simply has no stdin.
 */
export function terminalStateFor(
  transport: TerminalTransportState,
  capabilities: Capabilities | undefined,
): TerminalState {
  if (transport === 'writable' && capabilities !== undefined && !capabilities.input) {
    return 'read-only';
  }
  return transport;
}

/**
 * One view of a pipe session: the chunks of a single channel. Every chunk of the other channel is
 * reported parsed at once, because the host counts acknowledgements across both channels in
 * delivery order and a view that held the other channel's bytes would stall the producer.
 *
 * A view takes no input, and a view that fails closed stops the whole session.
 */
export function channelView(
  client: TerminalWebSocketClient,
  channel: OutputChannel,
): TerminalRendererController {
  return {
    subscribeOutput: (listener) =>
      client.subscribeOutput((chunk, parsed, source) => {
        if (source === channel) listener(chunk, parsed);
        else parsed();
      }),
    rendererFailed: (failure: TerminalRendererFailure) => client.rendererFailed(failure),
  };
}
