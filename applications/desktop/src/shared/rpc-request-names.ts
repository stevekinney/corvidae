import type { applicationRpcContract } from './rpc-contract.ts';

/** Runtime request names for the renderer's preview fallback; schemas stay main-only. */
export const applicationRequestNames = [
  'startChatRun',
  'abortChatRun',
] as const satisfies readonly (keyof typeof applicationRpcContract.bun.requests)[];

type ContractRequestNames = keyof typeof applicationRpcContract.bun.requests;
type MissingRequestNames = Exclude<ContractRequestNames, (typeof applicationRequestNames)[number]>;
type ExtraRequestNames = Exclude<(typeof applicationRequestNames)[number], ContractRequestNames>;
const requestNamesAreExhaustive: MissingRequestNames extends never
  ? ExtraRequestNames extends never
    ? true
    : never
  : never = true;
void requestNamesAreExhaustive;
