# Cleanup, version 1

Extension URI: `https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md`

A2A's `TASK_STATE_CANCELED` is terminal, but stopping a task and cleaning up after it are different events: cleanup (aborting tool calls, releasing resources, settling external effects) can still be running, can fail, or can be impossible to confirm after the task is already `CANCELED`. This extension carries the cleanup acknowledgement on the task, so a client that cares can wait for it and a client that does not can stop at the terminal state. It also carries the identifier of an open review that an operator, not the requester, resolves. A client needs nothing but this document and [the A2A specification](https://a2a-protocol.org/v1.0.1/specification/) to use it.

The URI is a stable identifier that clients compare as an opaque string. A client never needs to fetch it.

## Conventions in this document

Key words (MUST, SHOULD, MAY) have their RFC 2119 meaning. Examples are JSON-RPC 2.0 over HTTP, with A2A's JSON field names.

The `json` fences below that follow an HTML comment marker are machine-checked by `scripts/check-a2a-extension-schemas.ts` (`bun run --filter=@lostgradient/weft lint`):

- `<!-- schema: <name> -->` makes the next `json` fence a JSON Schema (draft 2020-12) named `<name>`.
- `<!-- example: <name> at <pointer> -->` makes the next `json` fence an example document. The value at the RFC 6901 JSON Pointer `<pointer>` must validate against schema `<name>`. `{uri}` in a pointer stands for this extension's URI, escaped as one pointer segment; an empty pointer is the whole document.

## Declaration

A server that tracks cleanup for its tasks advertises the extension in its Agent Card under `capabilities.extensions`.

<!-- example: params at /params -->

```json
{
  "uri": "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md",
  "description": "Reports whether a canceled task's cleanup finished, and the review an operator must resolve.",
  "required": false,
  "params": {}
}
```

`required` is always `false`: a client that does not know the extension gets plain A2A behavior.

### `AgentExtension.params`

Version 1 defines no parameters. A server sends `params` as an empty object or omits it. A client ignores keys it does not recognize.

<!-- schema: params -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Cleanup AgentExtension.params",
  "type": "object",
  "additionalProperties": false
}
```

## Activation

A client activates the extension per request by listing its URI in the `A2A-Extensions` request header (a comma-separated list of URIs). The server echoes the extensions it applied in the `A2A-Extensions` response header. A request that does not activate the extension gets plain A2A behavior: no extension metadata on the task. Activation applies to every method that returns a `Task`: `GetTask`, `ListTasks`, `CancelTask`, `SendMessage`, `SendStreamingMessage`, and `SubscribeToTask`.

## Versioning

The major version is part of the URI. A breaking change publishes a new URI (`cleanup-v2.md`) and the server never falls back to an older version on its own. A server MAY advertise several majors at once.

## Metadata namespace

Extension data lives in the `metadata` map of the `Task` (and of the `TaskStatusUpdateEvent` that announces a change), under the key that is this extension's URI. It never repurposes a core A2A field: the A2A `status.state` is unchanged and this namespace adds detail beside it. The namespace is present once the task has a cancellation or an open operator review, and absent otherwise.

| Field | Type | Meaning |
| --- | --- | --- |
| `cleanup.state` | string | Where the task's cancellation and cleanup stand; see the table below. Required when `cleanup` is present. |
| `cleanup.acknowledgement` | object | The cleanup acknowledgement, once one exists. Absent while `state` is `cancel-requested`, `canceled`, or `cleanup-pending`. |
| `cleanup.acknowledgement.status` | string | `not-required`, `completed`, `failed`, or `unresolved`. |
| `cleanup.acknowledgement.reason` | string | Present exactly when `status` is `unresolved`: `timed-out`, `unreachable`, `persistence-failed`, or `unknown-effect`. |
| `review` | object | The open review an operator resolves, when the task is `TASK_STATE_WORKING` on one. Holds `reviewId` and `kind` (`human-wait` or `tool-approval`), plus `signalName` for `human-wait` or `callId` for `tool-approval`. |

The acknowledgement carries no free-text error: the failure detail stays on the server.

### Acknowledgement statuses and the state they map to

| Acknowledgement | `cleanup.state` | Meaning |
| --- | --- | --- |
| none, stop requested | `cancel-requested` | Cancellation is recorded; the work has not stopped. |
| none, stop claimed | `canceled` | A durable run this server holds no live handle for had its cancellation requested. It claims the stop and says nothing about cleanup, because no acknowledgement exists to report. |
| none, cleanup outstanding | `cleanup-pending` | The task is terminal and cleanup is still running. |
| `not-required` or `completed` | `cleaned-up` | Terminal, with cleanup finished or unnecessary. |
| `failed` | `cleanup-failed` | Terminal, and cleanup definitely failed. |
| `unresolved` with `timed-out`, `unreachable`, or `persistence-failed` | `cleanup-unresolved` | Terminal, and cleanup could not be confirmed. It may still be running, so an external effect may still occur; a client MUST NOT treat the work as safely retryable. |
| `unresolved` with `unknown-effect` | `unknown-outcome` | An external effect may or may not have happened. |

`failed` is reserved for a definite, observed teardown failure; an incomplete or timed-out cleanup is `unresolved`, never `failed`.

These are the cleanup values of the receipt state vocabulary shared with `command-receipts-v1`. The `cancel-requested` and `canceled` receipts are the pre-acknowledgement states of a cancellation.

While the task is still non-terminal (`cancel-requested` while it is `TASK_STATE_WORKING`), `SubscribeToTask` carries the namespace on each status update. The acknowledgement settles after the task reaches `TASK_STATE_CANCELED`, when the A2A stream has ended and a new subscription is refused, so a client reads `cleanup-pending`, `cleaned-up`, `cleanup-failed`, `cleanup-unresolved`, and `unknown-outcome` by polling `GetTask`. `CancelTask` itself returns the task, so its response shows the state at the moment of the call, typically `cancel-requested` or `canceled` with no acknowledgement yet.

<!-- schema: metadata -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Cleanup Task metadata namespace",
  "type": "object",
  "properties": {
    "cleanup": {
      "type": "object",
      "required": ["state"],
      "properties": {
        "state": {
          "enum": [
            "cancel-requested",
            "canceled",
            "cleanup-pending",
            "cleaned-up",
            "cleanup-failed",
            "cleanup-unresolved",
            "unknown-outcome"
          ]
        },
        "acknowledgement": {
          "type": "object",
          "required": ["status"],
          "properties": {
            "status": { "enum": ["not-required", "completed", "failed", "unresolved"] },
            "reason": {
              "enum": ["timed-out", "unreachable", "persistence-failed", "unknown-effect"]
            }
          },
          "if": { "properties": { "status": { "const": "unresolved" } }, "required": ["status"] },
          "then": { "required": ["reason"] },
          "else": { "not": { "required": ["reason"] } },
          "additionalProperties": false
        }
      },
      "allOf": [
        {
          "if": { "not": { "required": ["acknowledgement"] } },
          "then": {
            "properties": {
              "state": { "enum": ["cancel-requested", "canceled", "cleanup-pending"] }
            }
          }
        },
        {
          "if": {
            "required": ["acknowledgement"],
            "properties": {
              "acknowledgement": {
                "properties": { "status": { "enum": ["not-required", "completed"] } }
              }
            }
          },
          "then": { "properties": { "state": { "const": "cleaned-up" } } }
        },
        {
          "if": {
            "required": ["acknowledgement"],
            "properties": {
              "acknowledgement": { "properties": { "status": { "const": "failed" } } }
            }
          },
          "then": { "properties": { "state": { "const": "cleanup-failed" } } }
        },
        {
          "if": {
            "required": ["acknowledgement"],
            "properties": {
              "acknowledgement": {
                "properties": {
                  "status": { "const": "unresolved" },
                  "reason": { "const": "unknown-effect" }
                },
                "required": ["status", "reason"]
              }
            }
          },
          "then": { "properties": { "state": { "const": "unknown-outcome" } } }
        },
        {
          "if": {
            "required": ["acknowledgement"],
            "properties": {
              "acknowledgement": {
                "properties": {
                  "status": { "const": "unresolved" },
                  "reason": { "enum": ["timed-out", "unreachable", "persistence-failed"] }
                },
                "required": ["status", "reason"]
              }
            }
          },
          "then": { "properties": { "state": { "const": "cleanup-unresolved" } } }
        }
      ],
      "additionalProperties": false
    },
    "review": {
      "type": "object",
      "required": ["reviewId", "kind"],
      "properties": {
        "reviewId": { "type": "string", "minLength": 1 },
        "kind": { "enum": ["human-wait", "tool-approval"] },
        "signalName": { "type": "string", "minLength": 1 },
        "callId": { "type": "string", "minLength": 1 }
      },
      "oneOf": [
        {
          "properties": { "kind": { "const": "human-wait" } },
          "required": ["signalName"],
          "not": { "required": ["callId"] }
        },
        {
          "properties": { "kind": { "const": "tool-approval" } },
          "required": ["callId"],
          "not": { "required": ["signalName"] }
        }
      ],
      "additionalProperties": false
    }
  },
  "minProperties": 1,
  "additionalProperties": false
}
```

## Review detail

A task waiting on a review that a requester answers is `TASK_STATE_INPUT_REQUIRED` or `TASK_STATE_AUTH_REQUIRED`, and the requester resolves it by continuing the task with a message. A task waiting on a review that an operator resolves stays `TASK_STATE_WORKING`, because the requester has nothing to supply; `review` carries its identifier so the requester can tell why the task is paused and an operator can find the review. The identifier is not a credential and grants nothing; resolving a review is an operator action on the management plane.

## Example flow

A requester cancels a running task.

Request, with the extension active (`A2A-Version: 1.0`, `A2A-Extensions: https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md`):

```json
{
  "jsonrpc": "2.0",
  "id": "cancel-1",
  "method": "CancelTask",
  "params": { "tenant": "acme", "id": "task-7" }
}
```

The response echoes `A2A-Extensions` with the same URI. The run has not stopped yet:

<!-- example: metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "cancel-1",
  "result": {
    "task": {
      "id": "task-7",
      "contextId": "ctx-3",
      "status": { "state": "TASK_STATE_WORKING" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md": {
          "cleanup": { "state": "cancel-requested" }
        }
      }
    }
  }
}
```

A later `GetTask` finds the task canceled and cleanup finished:

<!-- example: metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "get-1",
  "result": {
    "task": {
      "id": "task-7",
      "contextId": "ctx-3",
      "status": { "state": "TASK_STATE_CANCELED" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md": {
          "cleanup": { "state": "cleaned-up", "acknowledgement": { "status": "completed" } }
        }
      }
    }
  }
}
```

A canceled task whose cleanup could not be confirmed, which a client must not retry as if the work had never run:

<!-- example: metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "get-2",
  "result": {
    "task": {
      "id": "task-8",
      "contextId": "ctx-4",
      "status": { "state": "TASK_STATE_CANCELED" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md": {
          "cleanup": {
            "state": "cleanup-unresolved",
            "acknowledgement": { "status": "unresolved", "reason": "timed-out" }
          }
        }
      }
    }
  }
}
```

A task paused on a review an operator resolves:

<!-- example: metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "get-3",
  "result": {
    "task": {
      "id": "task-9",
      "contextId": "ctx-5",
      "status": { "state": "TASK_STATE_WORKING" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md": {
          "review": {
            "reviewId": "approval:run-9:call-2",
            "kind": "tool-approval",
            "callId": "call-2"
          }
        }
      }
    }
  }
}
```

## Errors

The extension adds no error codes. It produces the standard ones, each a JSON-RPC error envelope with HTTP 200 and an `error.data` array of `google.rpc.ErrorInfo` entries (A2A 1.0.1 section 9.5). Authentication (401) and rate limiting (429) are rejected before the JSON-RPC handler and use HTTP statuses.

| Code | When |
| --- | --- |
| `-32001` (`TaskNotFoundError`) | The task does not exist, was purged, or the caller may not see it. Denial is indistinguishable from absence. |
| `-32002` (`TaskNotCancelableError`) | `CancelTask` on a task that finished without being canceled (`COMPLETED`, `FAILED`, `REJECTED`) or that is already `CANCELED`. A repeated cancel has the same effect and the same error; the client reads the current cleanup progress with `GetTask`. |
| `-32602` (invalid params) | The request's `tenant` differs from the mounted interface's tenant. |
| `-32603` (internal error) | The server could not read the task's cleanup record. `error.data` carries an `ErrorInfo` with domain `bureau` and reason `UNAVAILABLE`, with retry detail; the client retries. |

A cleanup that has failed or cannot be confirmed is reported in the namespace, never as a JSON-RPC error: the cancel itself succeeded.
