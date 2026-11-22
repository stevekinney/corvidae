# Errors Reference

Weft reports failures at two granularities. A **`WeftErrorCode`** names the exact public error class that was thrown, such as `WorkflowNotFoundError`. A **`FaultCode`** is the coarse discriminant the server's operation pipeline attaches to every fault, such as `NotFound`, and it decides the HTTP status and the JSON-RPC error code. Many error classes collapse onto one fault code, and a fault raised by request validation has no error class behind it at all.

This page covers both vocabularies, how each transport puts them on the wire, and which guard to reach for when you catch one. The sources of truth are `src/core/fault-code.ts` and `src/core/weft-error.ts` in Weft, and in Backchannel `packages/backchannel/src/fault-code.ts`, `packages/backchannel/src/operation-fault.ts`, and `packages/backchannel/src/fault-to-json-rpc.ts`; Weft's own wrapper over the REST projections is `src/server/weft-operation-fault.ts`. `src/core/api-errors-documentation.test.ts` fails when the tables below drift from them.

## FaultCode

`FAULT_CODE_TO_HTTP_STATUS`, `FAULT_CODE_TO_JSON_RPC_CODE`, `FAULT_CODE_RETRYABLE`, and `FAULT_CODE_TO_FAILURE_CATEGORY` map every fault code. The JSON-RPC codes follow the specification for its reserved errors (`InvalidParams` and `MethodNotFound`) and use the Weft domain band `-32010` through `-32099` for everything else. The failure category is derived, not carried on the wire: compute it with `failureCategoryForFaultCode()`.

`Retryable` says whether the caller can expect the identical call to succeed if it simply tries again later, with no change by the caller. It is `true` only for `Timeout`, `RateLimited`, and `Unavailable`. A fault that needs fresh state (`StaleRevision`: re-read, then send the new revision) or different input, credentials, or capabilities is `false`, and so is a code that covers both a transient and a permanent case. It is a property of the code, not of the call site, so one table owns it.

| `FaultCode`             | HTTP status | JSON-RPC code | Failure category | Retryable |
| ----------------------- | ----------- | ------------- | ---------------- | --------- |
| `Unauthorized`          | 401         | -32010        | `application`    | `false`   |
| `Forbidden`             | 403         | -32011        | `application`    | `false`   |
| `NotFound`              | 404         | -32020        | `application`    | `false`   |
| `Conflict`              | 409         | -32021        | `application`    | `false`   |
| `Unprocessable`         | 422         | -32022        | `application`    | `false`   |
| `Timeout`               | 504         | -32023        | `timeout`        | `true`    |
| `PayloadTooLarge`       | 413         | -32024        | `resource`       | `false`   |
| `NotImplemented`        | 501         | -32025        | `system`         | `false`   |
| `UnsupportedTransport`  | 501         | -32030        | `system`         | `false`   |
| `SubscriptionOverflow`  | 500         | -32031        | `resource`       | `false`   |
| `InvalidParams`         | 400         | -32602        | `application`    | `false`   |
| `MethodNotFound`        | 404         | -32601        | `application`    | `false`   |
| `StaleRevision`         | 409         | -32026        | `application`    | `false`   |
| `RateLimited`           | 429         | -32027        | `resource`       | `true`    |
| `Unavailable`           | 503         | -32028        | `system`         | `true`    |
| `UnsupportedCapability` | 501         | -32029        | `system`         | `false`   |
| `EngineFailure`         | 500         | -32099        | `system`         | `false`   |

No fault code maps to the `cancellation` category: an aborted request never crosses the fault wire.

A REST binding with an established non-canonical status may override the HTTP status for its route. The JSON-RPC code is never overridden.

## Wire envelopes

The two transports use the same key, `weftCode`, for different vocabularies. Read this section before branching on it.

### REST

A REST fault response carries the status from the table above and a JSON body shaped `{ error, weftCode?, data?, retryable, remediation? }`:

- `error`: the human-readable message.
- `weftCode`: the fine-grained `WeftErrorCode` of the error class behind the fault, present only when the fault carried one. It is never a `FaultCode`, and the body carries no coarse code at all. The HTTP status is derived from the `FaultCode` but does not identify it: several codes share a status (`NotFound` and `MethodNotFound` are both 404, `NotImplemented`, `UnsupportedTransport`, and `UnsupportedCapability` all 501, `Conflict` and `StaleRevision` both 409, `SubscriptionOverflow` and `EngineFailure` both 500).
- `data`: an audited, deny-by-default subset of the fault's payload, omitted when no field is safe to expose. `REST_FAULT_DATA_EXTRACTORS` in Backchannel's `operation-fault.ts` lists the exposed fields per fault code.
- `retryable`: always present. `true` when repeating the identical call later can succeed with no change by the caller, from the `Retryable` column above; `false` otherwise.
- `remediation`: present only when the fault carries one. A single line of plain text, at most 500 characters and with no control character (newline and tab included), saying what the caller can do next. A value that breaks those limits is dropped from the wire rather than sent.

`StaleRevision`, `RateLimited`, `Unavailable`, and `UnsupportedCapability` carry typed `data` over REST:

| `FaultCode` | REST `data` fields |
| --- | --- |
| `StaleRevision` | `currentRevision` (always present), `expectedRevision` (when the caller supplied one) |
| `RateLimited` | `retryAfterSeconds` (when known) |
| `Unavailable` | `retryAfterSeconds` (when known) |
| `UnsupportedCapability` | `capability` |

`currentRevision` is what tells a client to re-read and retry rather than treat the fault as a plain `Conflict`. `retryAfterSeconds` is also emitted as the REST `Retry-After` header, rounded up to whole seconds. A value that is absent, negative, or not finite is dropped from the header, the REST body, and the JSON-RPC payload alike. `Unavailable.reason` is the only field of these four codes sent over JSON-RPC alone; REST omits it as internal detail.

A timed-out `weft.workflows.update` answers `Timeout` with `data.updateId` over both transports, on REST as the body's `data` and on JSON-RPC in the error's `data` (beside `operationName` when the fault carries one). The update stays queued after the caller gave up waiting, and the id is how the caller finds its answer later: read it with `weft.updates.result.get` while the answer is kept, or find the update among the entries `weft.workflows.updates.list` returns, which outlive the answer and are removed when the workflow is purged. Every other `Timeout` carries no `updateId`.

A bulk commit whose `confirmationToken` no longer matches the workflows the filter selects answers `Conflict` (`409` over REST, `-32021` over JSON-RPC) and changes nothing: the token is checked before any workflow is touched. That covers `weft.workflows.purge`, `weft.workflows.bulk.cancel`, `weft.workflows.bulk.delete`, `weft.workflows.bulk.tags`, `weft.workflows.bulk.retryfailed`, and `weft.workflows.bulk.signal`, and each declares `Conflict` in its producible faults. The fault's `data.reason` is `confirmation-token-stale`. The message ends with what to do: run the preview again with `dryRun: true`, then commit with the new token. A commit that carries no token, or input that does not parse, stays `InvalidParams`, so a client tells a stale preview from a malformed request by the code. The stale-token `Conflict` is `retryable: false`, like every `Conflict`: repeating the same commit cannot succeed, and its `remediation` names the preview to run again.

A `weft.workflows.purge` commit that deletes some workflows and fails for others answers `EngineFailure` with the message `Purge deleted N workflow(s) and failed for M.`, so a JSON-RPC caller learns whether anything was deleted; the deletes that committed are not undone, and the audit event is written with `failedCount` before the fault is returned. REST masks every `EngineFailure` to `Internal server error`, so a REST caller reads the audit event, or runs the preview again to see what is left. The fault is `retryable: false` and never carries a `remediation`, on any transport.

`Timeout` answers `504 Gateway Timeout`, not `408 Request Timeout`. A user agent may repeat a request that was answered `408` (RFC 9110 §15.5.9), and browsers do, so a timed-out `POST` such as `weft.workflows.update` would run again, each time as a new update. No user agent replays a `504`. `Timeout` is `retryable` in the sense that the same call can succeed later; that does not make it safe to repeat. A timed-out `weft.workflows.update` stays queued, so repeating it queues a second update, and the `data.updateId` it already returned is the way to read the first answer. The fault is otherwise the same on both transports: JSON-RPC code `-32023`, `weftCode` `Timeout`, and `httpStatus` 504 in the error's `data`.

The in-process rate limiter (`serve({ rateLimit })`) answers in the same shape. When a key is over budget, the middleware responds `429` with the `RateLimited` body `{ "error": "Too Many Requests", "data": { "retryAfterSeconds": <n> }, "retryable": true }`, the matching `Retry-After` header, and `X-RateLimit-Limit` and `X-RateLimit-Remaining`. It does so because the limiter knows when the window resets. The generated OpenAPI document lists `429` only on operations that declare `RateLimited`; it does not add the middleware's `429` to every route, so a client of a server configured with `rateLimit` should expect it on any authenticated route.

`EngineFailure` is masked: its body is exactly `{ "error": "Internal server error", "retryable": false }` with status 500, regardless of any route override. It never carries a `remediation`, even when the fault object holds one, on any transport.

An error that never passes through the fault model carries `error` alone, with no `retryable`: an unmatched route, a malformed route parameter, an authentication challenge, and the handler's last-resort internal error. Read a missing `retryable` as "no advice", not as `false`.

### JSON-RPC

A JSON-RPC fault is a standard error object, `{ code, message, data }`, where `code` comes from the table above. `data` carries the fault's full payload plus the envelope keys, written last so a payload field can never overwrite them:

- `data.weftCode`: the coarse `FaultCode`, such as `NotFound`. It is never a `WeftErrorCode`.
- `data.httpStatus`: the HTTP-equivalent status from the table above. Over the `/jsonrpc` HTTP endpoint the response status itself is always 200, so this is where the real status lives.
- `data.retryable`: always present, the same value the REST body carries.
- `data.remediation`: present only when the fault carries one, the same text the REST body carries.

Because the envelope's `weftCode` is written last, a fine-grained `WeftErrorCode` the fault carried does not survive onto the JSON-RPC wire.

### MCP

A catalog operation served as an MCP tool answers a fault as an error result (`isError: true`) whose `structuredContent` is `{ code, message, data?, retryable, remediation? }`, with the same `retryable` and `remediation` as the other two transports. Here `code` is the coarse `FaultCode`, and `data` is the fault's payload.

Weft's own MCP tools (`start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, `get_workflow_state`, and the tool of each workflow type) report a failure the same way, with `structuredContent` of `{ code, message, retryable, remediation? }` and no `data`, and the message still in the text content for a host that ignores `structuredContent`. They answer `NotFound` for a workflow that does not exist, `InvalidParams` for a refused argument or an unregistered workflow type, `Conflict` for an id already taken or a cancelled workflow, `Unauthorized` and `Forbidden` for a refused caller, `MethodNotFound` for an unknown tool, and the masked `EngineFailure` (`Tool execution failed`, never a `remediation`) for anything else.

### Command line

`weft workflow` and `weft schedule` report a failure in the same fields. With `--json`, stdout holds `{ "ok": false, "error": { code, message, retryable, remediation? } }` and stderr stays empty. Without it, stderr holds the message, then a `Try:` line when there is a `remediation`. The exit codes do not change. For a failure the server answered, `code` is the server's `FaultCode` (the JSON-RPC `data.weftCode`), and `retryable` and `remediation` are the server's. A failure the CLI finds itself uses the code of the same meaning: `Unavailable` (retryable) when the server cannot be reached, `MethodNotFound` when the server is older than the CLI, and `InvalidParams` for a usage or input error.

### Server-Sent Events

A stream that fails after it started ends with one `event: error` frame whose `data:` line is `{ code, message, data?, retryable, remediation? }`: the same `retryable` and `remediation` as the other transports, with `code` the coarse `FaultCode`. `data` holds only the fields the JSON-RPC envelope's `data` holds for that code, so no transport sends a field another withholds. A failure that is not a fault, or an `EngineFailure`, is `{ code: "EngineFailure", message: "Internal server error", retryable: false }`, never with a `remediation`. A request refused before the stream starts is an ordinary REST fault with the REST body above.

### What the client sees

`HttpClient` normalizes both envelopes onto `HttpClientError`, with one exception: a REST `GET` that answers 404 resolves to `null` before its body is read, so no `HttpClientError` is thrown and none of these fields exist. A missing resource on a read surfaces as a `null` result, not a catchable fault.

| Transport | `status` | `faultCode` | `category` | `weftCode` | `data` | `retryable`, `remediation` |
| --- | --- | --- | --- | --- | --- | --- |
| REST | Response status | `undefined` | `undefined` | Body `weftCode`, if any | Body `data`, if any | Body `retryable` and `remediation`, if any |
| JSON-RPC over HTTP | `data.httpStatus` | `data.weftCode` | Derived from `faultCode` | `undefined` | The whole envelope `data`, verbatim | `data.retryable` and `data.remediation`, if any |

`retryable` and `remediation` are `undefined` when the response carried none, as a response from a server that predates them does.

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
  if (error instanceof HttpClientError && error.status === 504) return 'timed out';
  if (isWeftErrorLike(error)) return `${error.code}: ${error.message}`;
  return 'unknown failure';
}
```

## WeftErrorCode

The registered public vocabulary—every code `isWeftErrorCode` accepts—with the file under `src/` that defines each class. A code outside this list is not stable and may change between releases. That includes every error not exported from `@lostgradient/weft`, and also the root-exported classes listed below.

| `WeftErrorCode` | Defined in |
| --- | --- |
| `WorkflowAlreadyExistsError` | `core/engine/errors.ts` |
| `BulkDeleteRequiresTerminalWorkflowsError` | `core/engine/errors.ts` |
| `BulkOperationConfirmationError` | `core/engine/errors.ts` |
| `WorkflowTypeNotRegisteredForRecoveryError` | `core/engine/errors.ts` |
| `EngineCreateNameMismatchError` | `core/engine/errors.ts` |
| `DefinitionSchemaRequiredError` | `core/engine/schema-policy.ts` |
| `EngineDisposedError` | `core/engine/errors.ts` |
| `EngineDisposalError` | `core/engine/errors.ts` |
| `WorkflowNotFoundError` | `core/engine/errors.ts` |
| `WorkflowNotRegisteredError` | `core/engine/errors.ts` |
| `WorkflowConcurrencyLimitExceededError` | `core/engine/errors.ts` |
| `WorkflowSuspendNotSupportedError` | `core/engine/errors.ts` |
| `ActivityResolutionError` | `core/engine/errors.ts` |
| `BranchTopologyChangedError` | `core/context/parallel-cache-entry.ts` |
| `PersistedDataIncompatibleError` | `core/persisted-data-incompatible-error.ts` |
| `PersistedDataCorruptError` | `core/persisted-data-incompatible-error.ts` |
| `WorkflowTimeoutError` | `core/timeouts.ts` |
| `HttpClientError` | `client/http-request.ts` |
| `WorkerProtocolIncompatibleError` | `worker/worker-protocol-incompatible-error.ts` |
| `UpdateTimeoutError` | `core/updates.ts` |
| `UpdateValidationError` | `core/updates.ts` |
| `WorkflowTerminalError` | `core/updates.ts` |
| `WorkflowBuilderError` | `core/types/workflow-builder-runtime.ts` |
| `VersionMismatchError` | `core/versioning.ts` |
| `EffectReplayConflictError` | `core/effect-log/index.ts` |
| `ReviewTimeoutError` | `core/review/index.ts` |
| `AtomicStateConflictError` | `core/atomic-state.ts` |
| `StandardSchemaValidationError` | `core/types/standard-schema-validate.ts` |
| `ActivityReconciliationCapabilityError` | `core/engine/activity-reconciliation.ts` |
| `ActivityReconciliationConflictError` | `core/engine/activity-reconciliation.ts` |
| `ActivityReconciliationIndeterminateError` | `core/engine/activity-reconciliation.ts` |
| `DurableActivityScopeError` | `core/context/durable-activity.ts` |
| `DurableActivityUnsupportedError` | `core/context/durable-activity.ts` |
| `AsyncActivityTokenNotFoundError` | `core/engine/async-activity-completion.ts` |
| `ActivityScheduleToCloseTimeoutError` | `core/context/activity-schedule-to-close.ts` |
| `ActivityPerAttemptTimeoutError` | `core/context/activity-schedule-to-close.ts` |
| `PayloadSizeExceededError` | `core/payload-size.ts` |
| `StartOrSignalConflictError` | `core/engine/errors.ts` |
| `UndeclaredWorkflowMessageError` | `core/engine/declared-messages.ts` |
| `WorkflowTeardownPendingError` | `core/engine/errors.ts` |
| `IdempotencyKeyPurgedError` | `core/engine/errors.ts` |
| `WorkerManifestBuildError` | `worker/manifest/registry-contract-builder.ts` |
| `OwnershipModeMismatchError` | `core/engine/lease-errors.ts` |
| `ApplicationCommandValidationError` | `core/mailbox-guards.ts` |
| `MailboxContentionError` | `core/mailbox-internals.ts` |
| `ApplicationDeliveryValidationError` | `core/outbox-guards.ts` |
| `OutboxContentionError` | `core/outbox-internals.ts` |
| `WaitBudgetElapsedError` | `core/application-primitive-abort.ts` |
| `WorkflowCatalogConflictError` | `core/catalog/errors.ts` |
| `WorkflowRevisionNotInstalledError` | `core/catalog/errors.ts` |
| `WorkflowSourceValidationError` | `core/source/errors.ts` |
| `WorkflowSourceNotRegisteredError` | `core/engine/dynamic-source-errors.ts` |
| `DynamicWorkflowSourceUnavailableError` | `core/engine/dynamic-source-errors.ts` |
| `WorkflowRevisionUnavailableError` | `core/engine/revision-errors.ts` |
| `EagerRecoveryRevisionRefusedError` | `core/engine/revision-errors.ts` |
| `ForkSourceReplacedError` | `core/engine/fork-source-replaced-error.ts` |
| `WorkflowCheckpointConflictError` | `core/engine/checkpoint-conflict-error.ts` |
| `ScheduleOccurrenceNotNextError` | `core/engine/schedule-occurrence-not-next-error.ts` |

### Root-exported errors without a registered code

These classes are exported from the package root and extend `WeftError`, but their codes are not in `WeftErrorCode`. `isWeftErrorCode` rejects them, and `isWeftErrorLike` and `isWeftFault` do not match them; use `instanceof` or `isWeftError` instead. The lease and claim errors are internal-only by design under ADR 0002; `src/core/engine/lease-errors.test.ts` asserts `WorkflowClaimUnavailableError` stays unregistered, following the `EngineLease*` precedent.

| Class                                    | Defined in                                     |
| ---------------------------------------- | ---------------------------------------------- |
| `CodegenEmitError`                       | `json-schema/codegen-emit-keywords.ts`         |
| `EngineLeaseAcquisitionTimeoutError`     | `core/engine/lease-errors.ts`                  |
| `EngineLeaseCorruptedError`              | `core/engine/lease-errors.ts`                  |
| `EngineLeaseNotHeldError`                | `core/engine/lease-errors.ts`                  |
| `ScheduleReservedKeyError`               | `core/engine/schedule-reserved-key-error.ts`   |
| `ScheduleStaleRevisionError`             | `core/engine/schedule-stale-revision-error.ts` |
| `WorkflowCatalogActivationConflictError` | `core/catalog/errors.ts`                       |
| `WorkflowClaimUnavailableError`          | `core/engine/lease-errors.ts`                  |
| `WorkflowContractConversionError`        | `core/contract/build.ts`                       |

### Root-exported errors outside the WeftError family

These classes are exported from the package root but extend plain `Error`, so `isWeftError`, `isWeftErrorLike`, `isWeftErrorCode`, and `isWeftFault` all reject them. Catch them with `instanceof`. The storage protocol's `StorageBatchOperationLimitExceededError` is exported by `@lostgradient/storage`, not by Weft; it too extends plain `Error`, with its own `code` property. `CatalogClientError`, which the typed catalog client throws, is exported by `@lostgradient/backchannel/client`, not by Weft. The three `Weft…Warning` classes are reported as process warnings rather than thrown, and the three `Chaos…Error` classes are produced only by the `withChaos` testing combinator.

| Class                                   | Defined in                                 |
| --------------------------------------- | ------------------------------------------ |
| `ChaosNonRetryableError`                | `testing/chaos.ts`                         |
| `ChaosTimeoutError`                     | `testing/chaos.ts`                         |
| `ChaosTransientError`                   | `testing/chaos.ts`                         |
| `ConnectionConfigurationError`          | `connection.ts`                            |
| `WeftWorkflowCheckpointConflictWarning` | `core/engine/checkpoint-conflict-error.ts` |
| `WeftWorkflowClaimLostWarning`          | `core/engine/lease-deposition.ts`          |
| `WeftWorkflowWakeDiscardedWarning`      | `core/engine/lease-deposition.ts`          |
| `WorkflowDocumentBranchError`           | `document-workflow/document-errors.ts`     |
| `WorkflowDocumentMapError`              | `document-workflow/document-errors.ts`     |
| `WorkflowDocumentReviewRejectedError`   | `document-workflow/document-errors.ts`     |
| `WorkflowDocumentSchemaError`           | `document-workflow/document-errors.ts`     |
| `WorkflowDocumentValidationError`       | `document-workflow/document.ts`            |
