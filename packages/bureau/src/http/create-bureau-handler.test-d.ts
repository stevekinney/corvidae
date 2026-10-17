// Type-level tripwire (COR-1300): `createBureauHandler` accepts exactly four
// options, and a `Bureau` reports whether its id was supplied. If this file
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
} satisfies BureauHandlerOptions;
export const handler: OperationHandler = createBureauHandler(bureau, everyOption);

// `publish`, `authentication`, `unauthenticatedAccess`, and `mounts` each stand alone.
createBureauHandler(bureau, { publish: ['support'] });
createBureauHandler(bureau, { authentication });
createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
createBureauHandler(bureau, { mounts: [mount] });

// `unauthenticatedAccess` is a closed union.
// @ts-expect-error -- only 'reject' and 'allow'
createBureauHandler(bureau, { unauthenticatedAccess: 'maybe' });

// `publish` is a list of names, not a single name.
// @ts-expect-error -- a string is not a string array
createBureauHandler(bureau, { publish: 'support' });

// The options deferred to A2A and hosting are not options.
// @ts-expect-error -- publicUrl returns with its consumer
createBureauHandler(bureau, { publicUrl: 'https://example.test' });
// @ts-expect-error -- discoveryUrl returns with its consumer
createBureauHandler(bureau, { discoveryUrl: 'https://example.test' });
// @ts-expect-error -- signing returns with its consumer
createBureauHandler(bureau, { signing: {} });
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
export const explicit: boolean = bureau.hasExplicitId;
// @ts-expect-error -- readonly
bureau.hasExplicitId = true;

// The scope list holds the two review scopes, as literal types.
export const reviewScope: BureauScope = BUREAU_SCOPES[0];
// @ts-expect-error -- not a Bureau scope
export const notAScope: BureauScope = 'bureau.tasks:read';
