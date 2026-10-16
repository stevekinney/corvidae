/**
 * Where the Playwright checks find the example. The port is fixed because the server decides its
 * origin allowlist before it listens.
 */
export const EXAMPLE_PORT = 54241;
export const EXAMPLE_ORIGIN = `http://127.0.0.1:${EXAMPLE_PORT}`;
