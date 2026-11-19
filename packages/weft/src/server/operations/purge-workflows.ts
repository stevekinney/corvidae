import { invalidParamsFault, type UnknownRestBinding } from '@lostgradient/backchannel/internals';
import { purgeOutputSchema } from './bulk-output-schemas.ts';
import {
  assertOperationEngineMethods,
  faultMessage,
  readOptionalJsonBody,
} from './operation-helpers.ts';

import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import type { z } from 'zod';
import { BulkOperationConfirmationError } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import { parseBulkListFilterFromBody } from './bulk-filter-body.ts';
import {
  bulkListFilterInputSchema,
  listFilterFromBulkInput,
  type BulkListFilterInput,
} from './bulk-filter-input.ts';
import {
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  parseBulkOperationControlFromBody,
  type BulkOperationControlInput,
} from './bulk-operation-controls.ts';

/** `data.reason` of the `Conflict` a purge commit answers when its confirmation token no longer matches. */
const STALE_PREVIEW_REASON = 'confirmation-token-stale';

/** Ends the stale-token message, so a caller that shows only the message still says what to do. */
const STALE_PREVIEW_REMEDIATION =
  'The workflows that match the filter changed after the preview. Run the preview again with ' +
  '`dryRun: true`, then commit with its new `confirmationToken`.';

const purgeWorkflowsInput =bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);

export type PurgeWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type PurgeWorkflowsOutput = z.output<typeof purgeOutputSchema>;

export const purgeWorkflowsOperation = defineOperation({
  name: 'weft.workflows.purge',
  mcpExposable: false,
  summary: 'Purge terminal workflows',
  description:
    'Permanently delete terminal workflows (completed, failed, cancelled, or timed ' +
    'out) that match the filter, removing every record they own, and report how many ' +
    'were removed. Irreversible; with no filter it matches every terminal workflow. ' +
    'Run it first with `dryRun: true` to preview the matches and receive a ' +
    '`confirmationToken`, then repeat the same filter with that token to commit; the commit ' +
    'deletes the previewed workflows and is refused with `Conflict` when the filter no longer ' +
    'produces the token; run the preview again. Requires workflows:admin.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: purgeWorkflowsInput,
  outputSchema: purgeOutputSchema,
  producibleFaults: ['Conflict'],
  access: bulkOperatorAccessPolicy,
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine, principal }): Promise<PurgeWorkflowsOutput> => {
    assertOperationEngineMethods(engine, ['purge']);
    const e = engine;

    // purge intentionally keeps inline tag coercion + filter assembly
    // local; it must allow empty filters (no scoped assert) and use the
    // canonical REST fault fallback (sanitized), so
    // `validatedListFilterFromBulkInput` is not appropriate here.
    // Validating tags in `invoke` also ensures JSON-RPC / stdio callers
    // hit the same `coerceStartWorkflowTags` check the REST
    // `extractInput` path runs via `parseBulkListFilterFromBody`.
    let validatedTags: string[] | undefined;
    if (input.tags !== undefined) {
      try {
        validatedTags = coerceStartWorkflowTags(input.tags, 'Field "filter.tags"');
      } catch (error) {
        throw invalidParamsFault(faultMessage(error));
      }
    }

    const filter = listFilterFromBulkInput({
      ...input,
      ...(validatedTags === undefined ? {} : { tags: validatedTags }),
    });
    const scope = Object.keys(filter).length === 0 ? undefined : filter;
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.purge(scope, operationOptions);
      }
      return await e.purge(scope, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        // The input was well formed; the matching workflows moved after the preview. That is a
        // conflict with the state the preview described, which a caller answers by previewing again,
        // so it must not share a code with input the caller got wrong.
        const fault: OperationFault = {
          code: 'Conflict',
          message: `${error.message}. ${STALE_PREVIEW_REMEDIATION}`,
          data: { reason: STALE_PREVIEW_REASON, weftCode: error.code },
        };
        throw fault;
      }
      throw error;
    }
  },
});

export const purgeWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/purge',
  pathParamNames: [],
  operationName: 'weft.workflows.purge',
  inputSources: {},
  extractInput: async (request, _pathParams, context) => {
    const raw = await readOptionalJsonBody(request, context);

    try {
      return { ...parseBulkListFilterFromBody(raw), ...parseBulkOperationControlFromBody(raw) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
};
