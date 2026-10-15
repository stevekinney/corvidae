// The public surface of `@lostgradient/terminal`. The `Terminal` component renders a session with
// the selected engine inside Cinder's `TerminalFrame`; the controller and WebSocket client arrive
// with later issues. Importing this module has no side effects: it does not construct or load the
// terminal engine (the component imports it dynamically, in the browser, when one mounts), touch
// DOM globals, fetch or compile WebAssembly, create workers, or start a session, and
// `bun run test:boundaries` proves it.
export * from './lib/components/terminal/index.ts';
export * from './terminal-engine.ts';
