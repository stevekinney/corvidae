// Type-level tripwire (COR-1300): `createBureauHandler` accepts exactly these
// options (COR-1547 added `maxRequestBodyBytes`), and a `Bureau` reports whether its id was supplied. If this file
// stops compiling, the handler's option surface or `Bureau.hasExplicitId`
// changed shape.

import type { AuthConfig, OperationHandler, OperationHandlerMount } from '@lostgradient/weft';

import type { Bureau } from '../types.ts';
import { BUREAU_SCOPES, type BureauScope } from './bureau-scopes.ts';
import { type BureauHandlerOptions, createBureauHandler } from './create-bureau-handler.ts';

declare const bureau: Bureau;
declare const authentication: AuthConfig;
declare const mount: OperationHandlerMount;

// Every option, each at its declared type.
const everyOption = {
  publish: ['support'],
  authentication,
  unauthenticatedAccess: 'reject',
  mounts: [mount],
  maxRequestBodyBytes: 1024,
} satisfies BureauHandlerOptions;
export const handler: OperationHandler = createBureauHandler(bureau, everyOption);

// `publish`, `authentication`, `unauthenticatedAccess`, and `mounts` each stand alone.
createBureauHandler(bureau, { publish: ['support'] });
createBureauHandler(bureau, { authentication });
createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
createBureauHandler(bureau, { mounts: [mount] });
createBureauHandler(bureau, { unauthenticatedAccess: 'allow', maxRequestBodyBytes: 1024 });

// `maxRequestBodyBytes` is a number of bytes.
// @ts-expect-error -- a string is not a number
createBureauHandler(bureau, { unauthenticatedAccess: 'allow', maxRequestBodyBytes: '1024' });

// `unauthenticatedAccess` is a closed union.
// @ts-expect-error -- only 'reject' and 'allow'
createBureauHandler(bureau, { unauthenticatedAccess: 'maybe' });

// `publish` is a list of names, not a single name.
// @ts-expect-error -- a string is not a string array
createBureauHandler(bureau, { publish: 'support' });

// A2A is mounted by `publicUrl` (COR-903), and `signing` is the kit's complete option shape.
createBureauHandler(bureau, { publicUrl: 'https://example.test' });
createBureauHandler(bureau, {
  publicUrl: 'https://example.test',
  discoveryUrl: 'https://discovery.example.test',
});
// @ts-expect-error -- signing needs a key, an algorithm, and a key id
createBureauHandler(bureau, { signing: {} });
// The options deferred to hosting are not options.
// @ts-expect-error -- cors returns with its consumer
createBureauHandler(bureau, { cors: {} });
// @ts-expect-error -- rateLimitKey returns with its consumer
createBureauHandler(bureau, { rateLimitKey: () => 'key' });
// @ts-expect-error -- limits returns with its consumer
createBureauHandler(bureau, { limits: {} });

// The options argument is required: the default rejects an unauthenticated handler.
// @ts-expect-error -- options are required
createBureauHandler(bureau);

// `Bureau.hasExplicitId` is a readonly boolean.
export const explicit: boolean = bureau.internals.hasExplicitId;
// @ts-expect-error -- readonly
bureau.hasExplicitId = true;

// The scope list holds the registered Bureau scopes, as literal types.
export const reviewScope: BureauScope = BUREAU_SCOPES[2];
export const fleetScope: BureauScope = 'bureau.events:observe-all';
// COR-1709: the decision operation is gated by its own write scope.
export const decisionsScope: BureauScope = 'bureau.decisions:write';
// COR-1710: the settings operations are gated by their own read and write scopes.
export const settingsReadScope: BureauScope = 'bureau.settings:read';
export const settingsWriteScope: BureauScope = 'bureau.settings:write';
// @ts-expect-error -- the delivery scopes are not registered
export const notAScope: BureauScope = 'bureau.deliveries:read';
