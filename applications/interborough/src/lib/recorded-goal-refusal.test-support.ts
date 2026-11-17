/**
 * The answer a real Bureau gave to `bureau.goals.create` for a configuration its validator's schema
 * refused (COR-2117), recorded from `packages/bureau/src/http/management/goals-operations.test.ts`
 * ("answers InvalidParams naming the field a configuration the schema refuses"), which asserts the
 * whole of it, so this copy cannot drift from the server's without that test failing.
 *
 * Where things sit: the JSON-RPC `error.code` is -32602; `error.data` holds `issues`, `weftCode` and
 * `httpStatus` (400, which the HTTP response carries too); each issue's `path` starts with
 * `['validator', 'configuration']` and then names the field inside the configuration.
 */
export const RECORDED_GOAL_REFUSAL = {
  jsonrpc: '2.0',
  error: {
    code: -32602,
    message:
      'The configuration for the validator "contains-phrase@1" is refused: phrase: Too small: expected string to have >=1 characters',
    data: {
      issues: [
        {
          path: ['validator', 'configuration', 'phrase'],
          message: 'Too small: expected string to have >=1 characters',
          code: 'custom',
        },
      ],
      weftCode: 'InvalidParams',
      httpStatus: 400,
    },
  },
  id: 1,
} as const;

/** The message the field shows for the recorded refusal. */
export const RECORDED_GOAL_REFUSAL_FIELD_MESSAGE =
  RECORDED_GOAL_REFUSAL.error.data.issues[0].message;
