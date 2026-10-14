/**
 * The `Terminal` component: Cinder's `TerminalFrame` around the selected terminal engine.
 *
 * @module
 */

// The engine's own stylesheet positions its helper textarea, accessibility tree, and scrollbar.
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import Terminal from './terminal.svelte';

export default Terminal;
export type {
  InputRefusal,
  InputRefusalReason,
  TerminalInputController,
} from '../../input/input-types.ts';
export type {
  TerminalGeometry,
  TerminalOutputListener,
  TerminalProps,
  TerminalRendererController,
  TerminalRendererFailure,
  TerminalRendererFailurePhase,
  TerminalState,
} from './terminal.types.ts';
export { Terminal };
