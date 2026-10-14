// The public surface of `@lostgradient/terminal`. The component, controller, and WebSocket client
// arrive with COR-478 and later issues; there is deliberately no `Terminal` stub before then.
// Importing this module has no side effects: it does not construct the terminal engine, touch DOM
// globals, fetch or compile WebAssembly, create workers, or start a session, and
// `bun run test:boundaries` proves it.
export * from './terminal-engine.ts';
