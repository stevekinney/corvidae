import { exampleEnvironment } from './environment-configuration.ts';

const environment = exampleEnvironment();

/** Where the Playwright checks find the example. See `environment-configuration.ts`. */
export const EXAMPLE_PORT = environment.port;
export const EXAMPLE_ORIGIN = `http://127.0.0.1:${EXAMPLE_PORT}`;
export const OWN_SERVER_PORT = environment.ownServerPort;
export const REFUSAL_PORT = environment.refusalPort;
export const START_TOKEN = environment.startToken;
