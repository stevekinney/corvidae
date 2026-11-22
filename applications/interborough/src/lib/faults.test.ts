/**
 * Six-code truth table for fault classification (plan §10.4, §11.1, T1.5).
 * Pure logic, no DOM — see `HttpClientError` shape notes in `faults.ts`'s
 * module doc for why these wire shapes (REST masked vs JSON-RPC full fault
 * object) are exactly what's constructed below.
 */
import { describe, expect, test } from 'bun:test';

import type { FaultCode } from '@lostgradient/backchannel';
import { HttpClientError, type WeftErrorCode } from '@lostgradient/weft';

import {
  canRetryFault,
  classifyFault,
  FAULT_TREATMENT_TITLE,
  faultAdvisingRetry,
  faultErrorStateAdvice,
  faultTreatment,
  isNetworkFailure,
  ServerUnreachableError,
  treatmentErrorStateAdvice,
  UNKNOWN_FAULT_TREATMENT,
  type FaultTreatmentKind,
} from './faults.ts';

/** Every `FaultCode` → the HTTP status `FAULT_CODE_TO_HTTP_STATUS` gives it (`weft/src/server/operation-fault.ts`), used to build realistic `HttpClientError`s below. */
const HTTP_STATUS_FOR_FAULT_CODE: Readonly<Record<FaultCode, number>> = {
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Unprocessable: 422,
  Timeout: 504,
  PayloadTooLarge: 413,
  NotImplemented: 501,
  UnsupportedTransport: 501,
  SubscriptionOverflow: 500,
  InvalidParams: 400,
  MethodNotFound: 404,
  StaleRevision: 409,
  RateLimited: 429,
  Unavailable: 503,
  UnsupportedCapability: 501,
  EngineFailure: 500,
};

function jsonRpcFault(faultCode: FaultCode, message = 'fault message'): HttpClientError {
  // Mirrors `httpClientCatalogTransport` (`weft/src/client/http-operations.ts`):
  // the JSON-RPC envelope always carries the coarse `faultCode`, unmasked,
  // regardless of which fault it is — including `EngineFailure`.
  return new HttpClientError(HTTP_STATUS_FOR_FAULT_CODE[faultCode], message, { faultCode });
}

function restMaskedInternalFault(): HttpClientError {
  // Mirrors `shapeRestFault` (`weft/src/server/operations/operation-helpers.ts`)
  // masking `EngineFailure`: flat `{ error: "Internal server error" }`, no
  // `faultCode`, no `weftCode` — status 500 is the only signal left.
  return new HttpClientError(500, 'Internal server error');
}

describe('classifyFault — six-code truth table', () => {
  const EXPECTED_KIND_FOR_FAULT_CODE: Readonly<Record<FaultCode, FaultTreatmentKind>> = {
    NotFound: 'not-found',
    MethodNotFound: 'not-found',
    Conflict: 'conflict',
    Unprocessable: 'invalid',
    InvalidParams: 'invalid',
    PayloadTooLarge: 'invalid',
    Unauthorized: 'unauthorized',
    Forbidden: 'unauthorized',
    NotImplemented: 'not-supported',
    UnsupportedTransport: 'not-supported',
    Timeout: 'internal',
    SubscriptionOverflow: 'internal',
    StaleRevision: 'conflict',
    RateLimited: 'internal',
    Unavailable: 'internal',
    UnsupportedCapability: 'not-supported',
    EngineFailure: 'internal',
  };
  const FAULT_CODES = [
    'NotFound',
    'MethodNotFound',
    'Conflict',
    'Unprocessable',
    'InvalidParams',
    'PayloadTooLarge',
    'Unauthorized',
    'Forbidden',
    'NotImplemented',
    'UnsupportedTransport',
    'Timeout',
    'SubscriptionOverflow',
    'StaleRevision',
    'RateLimited',
    'Unavailable',
    'UnsupportedCapability',
    'EngineFailure',
  ] as const satisfies readonly FaultCode[];

  for (const faultCode of FAULT_CODES) {
    test(`${faultCode} (JSON-RPC, unmasked) classifies as '${EXPECTED_KIND_FOR_FAULT_CODE[faultCode]}'`, () => {
      const treatment = classifyFault(jsonRpcFault(faultCode, 'wire message'));
      expect(treatment?.kind).toBe(EXPECTED_KIND_FOR_FAULT_CODE[faultCode]);
      expect(treatment?.message).toBe('wire message');
    });
  }

  test('every FaultCode is accounted for (no gaps if @lostgradient/weft adds one)', () => {
    const faultCodes = Object.keys(EXPECTED_KIND_FOR_FAULT_CODE);
    expect(new Set(faultCodes).size).toBe(faultCodes.length);
    expect(faultCodes).toHaveLength(17);
  });
});

describe('classifyFault — REST masked 500 vs JSON-RPC full fault object', () => {
  test('REST-masked EngineFailure (no faultCode, no weftCode) classifies as internal + maskedByRest + tryViaJsonRpc', () => {
    const treatment = classifyFault(restMaskedInternalFault());
    expect(treatment).toEqual({
      kind: 'internal',
      message: 'Internal server error',
      maskedByRest: true,
      tryViaJsonRpc: true,
    });
  });

  test('JSON-RPC EngineFailure (faultCode present, full fault object) classifies as internal without the masked hint', () => {
    const treatment = classifyFault(jsonRpcFault('EngineFailure', 'capturePayment threw'));
    expect(treatment).toEqual({
      kind: 'internal',
      message: 'capturePayment threw',
      maskedByRest: false,
      tryViaJsonRpc: false,
    });
  });

  test('an unmasked REST EngineFailure (structured faultToHttpResponse body) is also not flagged as masked', () => {
    // `faultToHttpResponse` (the REST default when an operation doesn't
    // override `shapeFault`) never masks — its structured body round-trips
    // `code: 'EngineFailure'` into `HttpClientError.faultCode` the same way
    // JSON-RPC does.
    const error = new HttpClientError(500, 'engine failure', { faultCode: 'EngineFailure' });
    const treatment = classifyFault(error);
    expect(treatment).toMatchObject({
      kind: 'internal',
      maskedByRest: false,
      tryViaJsonRpc: false,
    });
  });

  test('a raw 500 with no faultCode and unrelated message is still treated as (unattributed) masked-shaped internal', () => {
    // Genuinely ambiguous on the wire — a proxy/network 500 looks identical
    // to a masked EngineFailure from here. See faults.ts module doc.
    const error = new HttpClientError(500, 'Bad Gateway');
    const treatment = classifyFault(error);
    expect(treatment).toMatchObject({ kind: 'internal', maskedByRest: true, tryViaJsonRpc: true });
  });
});

describe('classifyFault — a fault code this build does not know', () => {
  test('is not classified, so the caller falls back to the unknown treatment', () => {
    // A newer engine can send a code the table has no kind for. The lookup finds nothing, and so
    // does a name every object inherits.
    for (const faultCode of ['SomeFutureFault', 'constructor']) {
      const error = new HttpClientError(500, 'from a newer engine', {
        faultCode: faultCode as FaultCode,
      });
      expect(classifyFault(error)).toBeNull();
      expect(faultTreatment(error)).toBe(UNKNOWN_FAULT_TREATMENT);
    }
  });
});

describe('classifyFault — conflict: spent idempotency key (REST-only)', () => {
  test('Conflict carrying weftCode: IdempotencyKeyPurgedError (REST sibling field) is flagged', () => {
    const error = new HttpClientError(409, 'a workflow with this id was already started', {
      faultCode: 'Conflict',
      weftCode: 'IdempotencyKeyPurgedError',
    });
    const treatment = classifyFault(error);
    expect(treatment).toEqual({
      kind: 'conflict',
      message: 'a workflow with this id was already started',
      isSpentIdempotencyKey: true,
    });
  });

  test('a different weftCode on the same Conflict (e.g. WorkflowAlreadyExistsError) is not flagged as spent-key', () => {
    const error = new HttpClientError(409, 'a workflow with this id already exists', {
      faultCode: 'Conflict',
      weftCode: 'WorkflowAlreadyExistsError',
    });
    const treatment = classifyFault(error);
    expect(treatment).toMatchObject({ kind: 'conflict', isSpentIdempotencyKey: false });
  });

  test('a plain Conflict with no weftCode at all is not flagged as spent-key', () => {
    const treatment = classifyFault(jsonRpcFault('Conflict'));
    expect(treatment).toMatchObject({ kind: 'conflict', isSpentIdempotencyKey: false });
  });

  test('over JSON-RPC the fine-grained weftCode is unreachable (envelope overwrites it with the coarse code) — never flagged', () => {
    // `httpClientCatalogTransport` never sets `HttpClientError.weftCode` at
    // all (only `faultCode`) — see faults.ts module doc. This test pins that
    // asymmetry so it isn't "fixed" here by accident.
    const error = new HttpClientError(409, 'purged key', { faultCode: 'Conflict' });
    expect(error.weftCode).toBeUndefined();
    const treatment = classifyFault(error);
    expect(treatment).toMatchObject({ kind: 'conflict', isSpentIdempotencyKey: false });
  });
});

describe('classifyFault — invalid: field errors', () => {
  test('fieldErrors is [] when the fault carried no data', () => {
    const treatment = classifyFault(jsonRpcFault('InvalidParams', 'invalid params'));
    expect(treatment).toMatchObject({ kind: 'invalid', fieldErrors: [] });
  });

  test('a REST error reads field errors from its data.issues', () => {
    // The REST body `{ error, data: { issues }, retryable }` as `HttpClientError` parses it: no
    // coarse `faultCode`, so the HTTP status picks the `invalid` bucket.
    const error = new HttpClientError(400, 'name: Required; options.0.label: Too short', {
      data: {
        issues: [
          { path: ['name'], message: 'Required', code: 'invalid_type' },
          { path: ['options', 0, 'label'], message: 'Too short', code: 'too_small' },
          { path: [], message: 'Unknown key', code: 'unrecognized_keys' },
        ],
      },
      retryable: false,
    });
    expect(classifyFault(error)).toEqual({
      kind: 'invalid',
      message: 'name: Required; options.0.label: Too short',
      fieldErrors: [
        { path: 'name', message: 'Required' },
        { path: 'options.0.label', message: 'Too short' },
        { path: '', message: 'Unknown key' },
      ],
      retryable: false,
    });
  });

  test('a JSON-RPC error reads field errors from the envelope data.issues', () => {
    const error = new HttpClientError(400, 'invalid params', {
      faultCode: 'InvalidParams',
      data: {
        issues: [{ path: ['type'], message: 'Required', code: 'invalid_type' }],
        weftCode: 'InvalidParams',
        httpStatus: 400,
      },
    });
    expect(classifyFault(error)).toMatchObject({
      kind: 'invalid',
      fieldErrors: [{ path: 'type', message: 'Required' }],
    });
  });

  test('skips an issue with no text message and ignores a data.issues that is not a list', () => {
    const skipped = new HttpClientError(400, 'bad', {
      data: { issues: [{ path: ['a'] }, 'text', null, { path: ['b'], message: 'Wrong' }] },
    });
    expect(classifyFault(skipped)).toMatchObject({
      fieldErrors: [{ path: 'b', message: 'Wrong' }],
    });
    const notAList = new HttpClientError(400, 'bad', { data: { issues: 'oops' } });
    expect(classifyFault(notAList)).toMatchObject({ kind: 'invalid', fieldErrors: [] });
  });
});

describe('classifyFault — retryable and remediation', () => {
  test('copies both from a REST error onto the treatment of any kind', () => {
    const error = new HttpClientError(404, 'No such run', {
      retryable: false,
      remediation: 'List the runs, then pick one that exists.',
    });
    expect(classifyFault(error)).toEqual({
      kind: 'not-found',
      message: 'No such run',
      retryable: false,
      remediation: 'List the runs, then pick one that exists.',
    });
  });

  test('copies retryable true from a transient fault', () => {
    const error = new HttpClientError(503, 'Unavailable', { retryable: true });
    expect(classifyFault(error)).toMatchObject({ kind: 'internal', retryable: true });
  });

  test('leaves both off a treatment whose error carried neither', () => {
    const treatment = classifyFault(new HttpClientError(404, 'No such run'));
    expect(treatment).toEqual({ kind: 'not-found', message: 'No such run' });
  });

  test('keeps the masked EngineFailure body not retryable with no remediation', () => {
    const error = new HttpClientError(500, 'Internal server error', { retryable: false });
    const treatment = classifyFault(error);
    expect(treatment).toMatchObject({ kind: 'internal', retryable: false });
    expect(treatment).not.toHaveProperty('remediation');
  });
});

describe('classifyFault — unauthorized: 401 reauth vs 403 forbidden', () => {
  test('faultCode Unauthorized (401) is reauth', () => {
    const treatment = classifyFault(jsonRpcFault('Unauthorized'));
    expect(treatment).toMatchObject({ kind: 'unauthorized', mode: 'reauth' });
  });

  test('faultCode Forbidden (403) is forbidden', () => {
    const treatment = classifyFault(jsonRpcFault('Forbidden'));
    expect(treatment).toMatchObject({ kind: 'unauthorized', mode: 'forbidden' });
  });

  test('no faultCode, status 401 falls back to reauth', () => {
    const error = new HttpClientError(401, 'no credential');
    expect(classifyFault(error)).toMatchObject({ kind: 'unauthorized', mode: 'reauth' });
  });

  test('no faultCode, status 403 falls back to forbidden', () => {
    const error = new HttpClientError(403, 'scope denied');
    expect(classifyFault(error)).toMatchObject({ kind: 'unauthorized', mode: 'forbidden' });
  });
});

describe('classifyFault — not-found and not-supported', () => {
  test('NotFound classifies as not-found', () => {
    expect(classifyFault(jsonRpcFault('NotFound', 'workflow wf-1 not found'))).toEqual({
      kind: 'not-found',
      message: 'workflow wf-1 not found',
    });
  });

  test('NotImplemented classifies as not-supported', () => {
    expect(classifyFault(jsonRpcFault('NotImplemented', 'not implemented'))).toEqual({
      kind: 'not-supported',
      message: 'not implemented',
    });
  });
});

describe('classifyFault — status fallback for every remaining bucket', () => {
  test.each([
    [404, 'not-found'],
    [409, 'conflict'],
    [400, 'invalid'],
    [413, 'invalid'],
    [422, 'invalid'],
    [501, 'not-supported'],
    [502, 'internal'],
  ] as const)('status %d with no faultCode falls back to %s', (status, expectedKind) => {
    const error = new HttpClientError(status, 'no faultCode on this response');
    expect(classifyFault(error)?.kind).toBe(expectedKind);
  });
});

describe('classifyFault — a request that got no answer', () => {
  test.each([
    'Failed to fetch',
    'fetch failed',
    'NetworkError when attempting to fetch resource.',
    'Load failed',
  ])('a fetch that failed with "%s" is unreachable', (message) => {
    const treatment = classifyFault(new TypeError(message));
    expect(treatment?.kind).toBe('unreachable');
    expect(isNetworkFailure(new TypeError(message))).toBe(true);
  });

  test('a change refused for the unreachable server reads as one', () => {
    expect(classifyFault(new ServerUnreachableError())?.kind).toBe('unreachable');
  });

  test('a server that answered with a 5xx is internal, never unreachable', () => {
    expect(classifyFault(new HttpClientError(503, 'Service unavailable'))?.kind).toBe('internal');
    expect(isNetworkFailure(new HttpClientError(503, 'Service unavailable'))).toBe(false);
  });

  test('a bug thrown while rendering is not a network failure', () => {
    expect(classifyFault(new TypeError('undefined is not a function'))).toBeNull();
    expect(isNetworkFailure(new TypeError('x.map is not a function'))).toBe(false);
  });
});

describe('classifyFault — errors that never crossed the Weft fault wire', () => {
  test('a plain Error is not classified', () => {
    expect(classifyFault(new Error('boom'))).toBeNull();
  });

  test('a non-error thrown value is not classified', () => {
    expect(classifyFault('boom')).toBeNull();
    expect(classifyFault(undefined)).toBeNull();
  });
});

describe('faultTreatment — always returns a treatment, falling back to UNKNOWN_FAULT_TREATMENT', () => {
  test('classifiable errors delegate to classifyFault', () => {
    const error = jsonRpcFault('NotFound');
    const classified = classifyFault(error);
    expect(classified).not.toBeNull();
    expect(faultTreatment(error)).toEqual(classified ?? UNKNOWN_FAULT_TREATMENT);
  });

  test('unclassifiable errors fall back to UNKNOWN_FAULT_TREATMENT', () => {
    expect(faultTreatment(new TypeError('x is not a function'))).toBe(UNKNOWN_FAULT_TREATMENT);
    expect(UNKNOWN_FAULT_TREATMENT.kind).toBe('internal');
  });
});

describe('FAULT_TREATMENT_TITLE', () => {
  test('has a sentence-case title for every treatment kind', () => {
    const kinds: readonly FaultTreatmentKind[] = [
      'not-found',
      'conflict',
      'invalid',
      'unauthorized',
      'not-supported',
      'internal',
      'unreachable',
    ];
    for (const kind of kinds) {
      expect(FAULT_TREATMENT_TITLE[kind]).toEqual(expect.any(String));
      expect(FAULT_TREATMENT_TITLE[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('the fault-to-view mapping: remediation and Retry', () => {
  const retry = () => {};

  /** One fault of each treatment kind, each carrying a remediation line where the wire can. */
  const faultOfEachKind: readonly (readonly [FaultTreatmentKind, () => unknown])[] = [
    ['not-found', () => new HttpClientError(404, 'No such run', { remediation: 'List the runs.' })],
    ['conflict', () => new HttpClientError(409, 'Stale', { remediation: 'Read it again.' })],
    ['invalid', () => new HttpClientError(422, 'Bad', { remediation: 'Fix the input.' })],
    ['unauthorized', () => new HttpClientError(401, 'No', { remediation: 'Sign in again.' })],
    ['not-supported', () => new HttpClientError(501, 'No', { remediation: 'Use another host.' })],
    ['internal', () => new HttpClientError(500, 'Broke', { remediation: 'Check the logs.' })],
    ['unreachable', () => new ServerUnreachableError()],
  ];

  test('covers every treatment kind', () => {
    expect(faultOfEachKind.map(([kind]) => kind).sort()).toEqual(
      (Object.keys(FAULT_TREATMENT_TITLE) as FaultTreatmentKind[]).sort(),
    );
  });

  for (const [kind, build] of faultOfEachKind) {
    test(`${kind}: passes the remediation the fault carries, and none it does not`, () => {
      const treatment = faultTreatment(build());
      expect(treatment.kind).toBe(kind);
      const advice = faultErrorStateAdvice(build(), retry);
      if (kind === 'unreachable') {
        expect(advice).not.toHaveProperty('remediation');
      } else {
        expect(advice.remediation).toBe(treatment.remediation);
        expect(advice.remediation).toEqual(expect.any(String));
      }
    });
  }

  test('offers Retry for a fault that is retryable or says nothing about it', () => {
    const retryable = new HttpClientError(503, 'Unavailable', { retryable: true });
    const silent = new HttpClientError(503, 'Unavailable');
    expect(faultErrorStateAdvice(retryable, retry).onRetry).toBe(retry);
    expect(faultErrorStateAdvice(silent, retry).onRetry).toBe(retry);
    expect(faultErrorStateAdvice(new Error('render bug'), retry).onRetry).toBe(retry);
    expect(canRetryFault(faultTreatment(silent))).toBe(true);
  });

  test('offers no Retry for a fault that is not retryable, whatever its kind', () => {
    for (const [, build] of faultOfEachKind) {
      const error = build();
      if (!(error instanceof HttpClientError)) continue;
      const notRetryable = new HttpClientError(error.status, error.message, {
        retryable: false,
        remediation: 'Do the other thing.',
      });
      const advice = faultErrorStateAdvice(notRetryable, retry);
      expect(advice).not.toHaveProperty('onRetry');
      expect(advice.remediation).toBe('Do the other thing.');
    }
  });

  test('a screen that reads several things keeps Retry while any failed read could succeed again', () => {
    const permanent = new HttpClientError(409, 'Changed', { retryable: false });
    const transient = new HttpClientError(503, 'Unavailable', { retryable: true });
    const silent = new Error('boom');
    expect(faultAdvisingRetry([permanent, transient])).toBe(transient);
    expect(faultAdvisingRetry([null, permanent, silent])).toBe(silent);
    expect(faultAdvisingRetry([permanent, null])).toBe(permanent);
    expect(canRetryFault(faultTreatment(faultAdvisingRetry([permanent, null])))).toBe(false);
    expect(faultAdvisingRetry([null, undefined])).toBeUndefined();
  });

  test('offers no Retry where the caller has none, and leaves out an empty remediation', () => {
    const treatment = { ...faultTreatment(new HttpClientError(500, 'x')), remediation: '' };
    expect(treatmentErrorStateAdvice(treatment)).toEqual({});
  });
});

describe('isWeftFault ground truth (weft-error.ts), pinned so the Conflict tests above stay meaningful', () => {
  test('matches structurally via HttpClientError.weftCode, not just instanceof', () => {
    const code: WeftErrorCode = 'IdempotencyKeyPurgedError';
    const matching = new HttpClientError(409, 'x', { weftCode: code });
    const nonMatching = new HttpClientError(409, 'x', { weftCode: 'WorkflowAlreadyExistsError' });
    const bare = new HttpClientError(409, 'x');

    expect('weftCode' in matching).toBe(true);
    expect(matching.weftCode).toBe(code);
    expect(nonMatching.weftCode).not.toBe(code);
    expect(bare.weftCode).toBeUndefined();
  });
});
