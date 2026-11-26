import {
  createBureauClientWithTransport,
  type BureauDryRunOutput,
  type BureauOutput,
} from './client.ts';

const client = createBureauClientWithTransport(async () => null, { baseUrl: '' });
declare const runtimeBoolean: boolean;
export const omitted: Promise<BureauOutput<'bureau.tasks.cancel'>> = client['bureau.tasks.cancel']({
  taskId: 'task',
});
export const explicitFalse: Promise<BureauOutput<'bureau.tasks.cancel'>> = client[
  'bureau.tasks.cancel'
]({ taskId: 'task', dryRun: false });
export const explicitTrue: Promise<BureauDryRunOutput<'bureau.tasks.cancel'>> = client[
  'bureau.tasks.cancel'
]({ taskId: 'task', dryRun: true });
export const dynamic: Promise<
  BureauOutput<'bureau.tasks.cancel'> | BureauDryRunOutput<'bureau.tasks.cancel'>
> = client['bureau.tasks.cancel']({ taskId: 'task', dryRun: runtimeBoolean });
