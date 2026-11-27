/**
 * Type-level checks for the dry run's answer on the Bureau client (COR-2522): an ordinary call keeps
 * the answer it always had, a call with `dryRun: true` answers the preview, and a `dryRun` the
 * compiler cannot decide answers either.
 */
import {
  createBureauClientWithTransport,
  type BureauDryRunOutput,
  type BureauOutput,
} from '@lostgradient/bureau-sdk';
import { bureauClient } from './bureau-api.ts';

const portable = createBureauClientWithTransport(async () => null, { baseUrl: '' });
export const portableNormal: Promise<BureauOutput<'bureau.tasks.cancel'>> = portable[
  'bureau.tasks.cancel'
]({ taskId: 'task' });
export const portableFalse: Promise<BureauOutput<'bureau.tasks.cancel'>> = portable[
  'bureau.tasks.cancel'
]({ taskId: 'task', dryRun: false });
export const portablePreview: Promise<BureauDryRunOutput<'bureau.tasks.cancel'>> = portable[
  'bureau.tasks.cancel'
]({ taskId: 'task', dryRun: true });
declare const runtimeDryRun: boolean;
export const portableDynamic: Promise<
  BureauOutput<'bureau.tasks.cancel'> | BureauDryRunOutput<'bureau.tasks.cancel'>
> = portable['bureau.tasks.cancel']({ taskId: 'task', dryRun: runtimeDryRun });

const ordinary = () => bureauClient['bureau.tasks.cancel']({ taskId: 'task-1' });
export const ordinaryReceipt: Awaited<ReturnType<typeof ordinary>>['receipt'] = 'canceled';

const falsely = () => bureauClient['bureau.tasks.cancel']({ taskId: 'task-1', dryRun: false });
export const falseReceipt: Awaited<ReturnType<typeof falsely>>['receipt'] = 'canceled';

const preview = () => bureauClient['bureau.tasks.cancel']({ taskId: 'task-1', dryRun: true });
export const previewEffects: Awaited<ReturnType<typeof preview>>['effects'] = [];
// @ts-expect-error a preview names no receipt: nothing was cancelled.
export const previewReceipt: Awaited<ReturnType<typeof preview>>['receipt'] = 'canceled';

declare const preferred: boolean;
const either = () => bureauClient['bureau.tasks.cancel']({ taskId: 'task-1', dryRun: preferred });
// @ts-expect-error the answer may be the preview, which has no receipt.
export const eitherReceipt: Awaited<ReturnType<typeof either>>['receipt'] = 'canceled';
