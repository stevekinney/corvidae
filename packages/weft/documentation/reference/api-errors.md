# Errors Reference

Weft reports failures at two granularities. A **`WeftErrorCode`** names the exact public error class that was thrown, such as `WorkflowNotFoundError`. A **`FaultCode`** is the coarse discriminant the server's operation pipeline attaches to every fault, such as `NotFound`, and it decides the HTTP status and the JSON-RPC error code. Many error classes collapse onto one fault code, and a fault raised by request validation has no error class behind it at all.

This page covers both vocabularies, how each transport puts them on the wire, and which guard to reach for when you catch one. The sources of truth are `src/core/fault-code.ts`, `src/core/weft-error.ts`, `src/server/operation-fault.ts`, and `src/server/fault-to-json-rpc.ts`; `src/core/api-errors-documentation.test.ts` fails when the tables below drift from them.

## FaultCode

`FAULT_CODE_TO_HTTP_STATUS`, `FAULT_CODE_TO_JSON_RPC_CODE`, and `FAULT_CODE_TO_FAILURE_CATEGORY` map every fault code. The JSON-RPC codes follow the specification for its reserved errors (`InvalidParams` and `MethodNotFound`) and use the Weft domain band `-32010` through `-32099` for everything else. The failure category is derived, not carried on the wire: compute it with `failureCategoryForFaultCode()`.

| `FaultCode`             | HTTP status | JSON-RPC code | Failure category |
| ----------------------- | ----------- | ------------- | ---------------- |
| `Unauthorized`          | 401         | -32010        | `application`    |
| `Forbidden`             | 403         | -32011        | `application`    |
| `NotFound`              | 404         | -32020        | `application`    |
| `Conflict`              | 409         | -32021        | `application`    |
| `Unprocessable`         | 422         | -32022        | `application`    |
| `Timeout`               | 408         | -32023        | `timeout`        |
| `PayloadTooLarge`       | 413         | -32024        | `resource`       |
| `NotImplemented`        | 501         | -32025        | `system`         |
| `UnsupportedTransport`  | 501         | -32030        | `system`         |
| `SubscriptionOverflow`  | 500         | -32031        | `resource`       |
| `InvalidParams`         | 400         | -32602        | `application`    |
| `MethodNotFound`        | 404         | -32601        | `application`    |
| `StaleRevision`         | 409         | -32026        | `application`    |
| `RateLimited`           | 429         | -32027        | `resource`       |
| `Unavailable`           | 503         | -32028        | `system`         |
| `UnsupportedCapability` | 501         | -32029        | `system`         |
| `EngineFailure`         | 500         | -32099        | `system`         |

No fault code maps to the `cancellation` category: an aborted request never crosses the fault wire.

A REST binding with an established non-canonical status may override the HTTP status for its route. The JSON-RPC code is never overridden.

## Wire envelopes

The two transports use the same key, `weftCode`, for different vocabularies. Read this section before branching on it.

### REST

A REST fault response carries the status from the table above and a JSON body shaped `{ error, weftCode?, data? }`:

- `error`: the human-readable message.
- `weftCode`: the fine-grained `WeftErrorCode` of the error class behind the fault, present only when the fault carried one. It is never a `FaultCode`, and the body carries no coarse code at all. The HTTP status is derived from the `FaultCode` but does not identify it: several codes share a status (`NotFound` and `MethodNotFound` are both 404, `NotImplemented`, `UnsupportedTransport`, and `UnsupportedCapability` all 501, `Conflict` and `StaleRevision` both 409, `SubscriptionOverflow` and `EngineFailure` both 500).
- `data`: an audited, deny-by-default subset of the fault's payload, omitted when no field is safe to expose. `REST_FAULT_DATA_EXTRACTORS` in `operation-fault.ts` lists the exposed fields per fault code.

`RateLimited` and `Unavailable` may carry `retryAfterSeconds`. Over REST it is emitted as the `Retry-After` header, rounded up to whole seconds and omitted when absent, negative, or not finite; the four codes `StaleRevision`, `RateLimited`, `Unavailable`, and `UnsupportedCapability` disclose nothing else in the REST body. Over JSON-RPC the full payload travels in `data` (`expectedRevision` and `currentRevision` for `StaleRevision`, `retryAfterSeconds` for `RateLimited`, `reason` and `retryAfterSeconds` for `Unavailable`, `capability` for `UnsupportedCapability`).

`EngineFailure` is masked: its body is exactly `{ "error": "Internal server error" }` with status 500, regardless of any route override.

### JSON-RPC

A JSON-RPC fault is a standard error object, `{ code, message, data }`, where `code` comes from the table above. `data` carries the fault's full payload plus two envelope keys, written last so a payload field can never overwrite them:

- `data.weftCode`: the coarse `FaultCode`, such as `NotFound`. It is never a `WeftErrorCode`.
- `data.httpStatus`: the HTTP-equivalent status from the table above. Over the `/jsonrpc` HTTP endpoint the response status itself is always 200, so this is where the real status lives.

Because the envelope's `weftCode` is written last, a fine-grained `WeftErrorCode` the fault carried does not survive onto the JSON-RPC wire.

### What the client sees

`HttpClient` normalizes both envelopes onto `HttpClientError`, with one exception: a REST `GET` that answers 404 resolves to `null` before its body is read, so no `HttpClientError` is thrown and none of these fields exist. A missing resource on a read surfaces as a `null` result, not a catchable fault.

| Transport | `status` | `faultCode` | `category` | `weftCode` | `data` |
| --- | --- | --- | --- | --- | --- |
| REST | Response status | `undefined` | `undefined` | Body `weftCode`, if any | Body `data`, if any |
| JSON-RPC over HTTP | `data.httpStatus` | `data.weftCode` | Derived from `faultCode` | `undefined` | The whole envelope `data`, verbatim |

So `isWeftFault(error, 'WorkflowNotFoundError')` matches an `HttpClientError` from a REST response that carried that code, but not one from a JSON-RPC response. `faultCode` and `category` have the opposite gap: they are populated only for JSON-RPC. The one field both transports normalize is `status`, so branch on it for coarse handling that must work whichever transport an operation uses.

## Error helpers

Most public Weft errors extend `WeftError`, whose `code` equals the class name. A few root exports extend plain `Error` instead and are invisible to every guard below; [they are listed at the end of this page](#root-exported-errors-outside-the-wefterror-family). For the `WeftError` family, four guards narrow a caught value:

| Guard | Narrows | Use it when |
| --- | --- | --- |
| `isWeftError(value)` | A live `WeftError` instance | The error came from the same module instance and you want the class. |
| `isWeftErrorLike(value)` | `{ code: WeftErrorCode; message: string }` | The error may have crossed a realm or a duplicate copy of `@lostgradient/weft`, where `instanceof` fails. |
| `isWeftErrorCode(value)` | A bare `WeftErrorCode` string | You hold a code string, such as a REST body's `weftCode`, rather than an error. |
| `isWeftFault(error, code)` | Whether `error` is that code | One branch must work for both `LocalClient` and REST-backed `HttpClient` operations. It never matches a JSON-RPC-backed one, which carries no fine-grained code. |

`isFaultCode(value)` is the coarse counterpart of `isWeftErrorCode`: it narrows a wire string to a `FaultCode`.

```typescript
import { HttpClientError, isWeftErrorLike, isWeftFault } from '@lostgradient/weft';

function describeFailure(error: unknown): string {
  if (isWeftFault(error, 'WorkflowNotFoundError')) return 'missing workflow';
  if (error instanceof HttpClientError && error.status === 408) return 'timed out';
  if (isWeftErrorLike(error)) return `${error.code}: ${error.message}`;
  return 'unknown failure';
}
```

## WeftErrorCode

The registered public vocabulary—every code `isWeftErrorCode` accepts—with the file under `src/` that defines each class. A code outside this list is not stable and may change between releases. That includes every error not exported from `@lostgradient/weft`, and also the root-exported classes listed below.

| `WeftErrorCode`                             | Defined in                                     |
| ------------------------------------------- | ---------------------------------------------- |
| `WorkflowAlreadyExistsError`                | `core/engine/errors.ts`                        |
| `BulkDeleteRequiresTerminalWorkflowsError`  | `core/engine/errors.ts`                        |
| `BulkOperationConfirmationError`            | `core/engine/errors.ts`                        |
| `WorkflowTypeNotRegisteredForRecoveryError` | `core/engine/errors.ts`                        |
| `EngineCreateNameMismatchError`             | `core/engine/errors.ts`                        |
| `EngineDisposedError`                       | `core/engine/errors.ts`                        |
| `EngineDisposalError`                       | `core/engine/errors.ts`                        |
| `WorkflowNotFoundError`                     | `core/engine/errors.ts`                        |
| `WorkflowNotRegisteredError`                | `core/engine/errors.ts`                        |
| `WorkflowConcurrencyLimitExceededError`     | `core/engine/errors.ts`                        |
| `WorkflowSuspendNotSupportedError`          | `core/engine/errors.ts`                        |
| `ActivityResolutionError`                   | `core/engine/errors.ts`                        |
| `BranchTopologyChangedError`                | `core/context/parallel-cache-entry.ts`         |
| `PersistedDataIncompatibleError`            | `core/persisted-data-incompatible-error.ts`    |
| `PersistedDataCorruptError`                 | `core/persisted-data-incompatible-error.ts`    |
| `WorkflowTimeoutError`                      | `core/timeouts.ts`                             |
| `HttpClientError`                           | `client/http-request.ts`                       |
| `WorkerProtocolIncompatibleError`           | `worker/worker-protocol-incompatible-error.ts` |
| `UpdateTimeoutError`                        | `core/updates.ts`                              |
| `UpdateValidationError`                     | `core/updates.ts`                              |
| `WorkflowTerminalError`                     | `core/updates.ts`                              |
| `WorkflowBuilderError`                      | `core/types/workflow-builder-runtime.ts`       |
| `VersionMismatchError`                      | `core/versioning.ts`                           |
| `EffectReplayConflictError`                 | `core/effect-log/index.ts`                     |
| `ReviewTimeoutError`                        | `core/review/index.ts`                         |
| `AtomicStateConflictError`                  | `core/atomic-state.ts`                         |
| `StandardSchemaValidationError`             | `core/types/standard-schema-validate.ts`       |
| `ActivityReconciliationCapabilityError`     | `core/engine/activity-reconciliation.ts`       |
| `ActivityReconciliationConflictError`       | `core/engine/activity-reconciliation.ts`       |
| `ActivityReconciliationIndeterminateError`  | `core/engine/activity-reconciliation.ts`       |
| `DurableActivityScopeError`                 | `core/context/durable-activity.ts`             |
| `DurableActivityUnsupportedError`           | `core/context/durable-activity.ts`             |
| `AsyncActivityTokenNotFoundError`           | `core/engine/async-activity-completion.ts`     |
| `ActivityScheduleToCloseTimeoutError`       | `core/context/activity-schedule-to-close.ts`   |
| `ActivityPerAttemptTimeoutError`            | `core/context/activity-schedule-to-close.ts`   |
| `PayloadSizeExceededError`                  | `core/payload-size.ts`                         |
| `StartOrSignalConflictError`                | `core/engine/errors.ts`                        |
| `WorkflowTeardownPendingError`              | `core/engine/errors.ts`                        |
| `IdempotencyKeyPurgedError`                 | `core/engine/errors.ts`                        |
| `WorkerManifestBuildError`                  | `worker/manifest/registry-contract-builder.ts` |
| `OwnershipModeMismatchError`                | `core/engine/lease-errors.ts`                  |
| `ApplicationCommandValidationError`         | `core/mailbox-guards.ts`                       |
| `MailboxContentionError`                    | `core/mailbox-internals.ts`                    |
| `ApplicationDeliveryValidationError`        | `core/outbox-guards.ts`                        |
| `OutboxContentionError`                     | `core/outbox-internals.ts`                     |
| `WaitBudgetElapsedError`                    | `core/application-primitive-abort.ts`          |
| `WorkflowCatalogConflictError`              | `core/catalog/errors.ts`                       |
| `WorkflowRevisionNotInstalledError`         | `core/catalog/errors.ts`                       |
| `WorkflowSourceValidationError`             | `core/source/errors.ts`                        |
| `WorkflowSourceNotRegisteredError`          | `core/engine/dynamic-source-errors.ts`         |
| `DynamicWorkflowSourceUnavailableError`     | `core/engine/dynamic-source-errors.ts`         |
| `WorkflowRevisionUnavailableError`          | `core/engine/revision-errors.ts`               |
| `EagerRecoveryRevisionRefusedError`         | `core/engine/revision-errors.ts`               |
| `ForkSourceReplacedError`                   | `core/engine/fork-source-replaced-error.ts`    |
| `WorkflowCheckpointConflictError`           | `core/engine/checkpoint-conflict-error.ts`     |

### Root-exported errors without a registered code

These classes are exported from the package root and extend `WeftError`, but their codes are not in `WeftErrorCode`. `isWeftErrorCode` rejects them, and `isWeftErrorLike` and `isWeftFault` do not match them; use `instanceof` or `isWeftError` instead. The lease and claim errors are internal-only by design under ADR 0002; `src/core/engine/lease-errors.test.ts` asserts `WorkflowClaimUnavailableError` stays unregistered, following the `EngineLease*` precedent.

| Class                                | Defined in                             |
| ------------------------------------ | -------------------------------------- |
| `CodegenEmitError`                   | `json-schema/codegen-emit-keywords.ts` |
| `EngineLeaseAcquisitionTimeoutError` | `core/engine/lease-errors.ts`          |
| `EngineLeaseCorruptedError`          | `core/engine/lease-errors.ts`          |
| `EngineLeaseNotHeldError`            | `core/engine/lease-errors.ts`          |
| `WorkflowClaimUnavailableError`      | `core/engine/lease-errors.ts`          |
| `WorkflowContractConversionError`    | `core/contract/build.ts`               |

### Root-exported errors outside the WeftError family

These classes are exported from the package root but extend plain `Error`, so `isWeftError`, `isWeftErrorLike`, `isWeftErrorCode`, and `isWeftFault` all reject them, even where the class carries its own `code` property (`StorageBatchOperationLimitExceededError` does). Catch them with `instanceof`. The three `Weft…Warning` classes are reported as process warnings rather than thrown, and the three `Chaos…Error` classes are produced only by the `withChaos` testing combinator.

| Class                                     | Defined in                                 |
| ----------------------------------------- | ------------------------------------------ |
| `CatalogClientError`                      | `client/operation-client-runtime.ts`       |
| `ChaosNonRetryableError`                  | `testing/chaos.ts`                         |
| `ChaosTimeoutError`                       | `testing/chaos.ts`                         |
| `ChaosTransientError`                     | `testing/chaos.ts`                         |
| `ConnectionConfigurationError`            | `connection.ts`                            |
| `StorageBatchOperationLimitExceededError` | `storage/interface.ts`                     |
| `WeftWorkflowCheckpointConflictWarning`   | `core/engine/checkpoint-conflict-error.ts` |
| `WeftWorkflowClaimLostWarning`            | `core/engine/lease-deposition.ts`          |
| `WeftWorkflowWakeDiscardedWarning`        | `core/engine/lease-deposition.ts`          |
