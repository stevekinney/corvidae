import {
  createBureauClientWithTransport,
  type BureauDryRunOutput,
  type BureauEvent,
  type BureauInput,
  type BureauOutput,
} from '@lostgradient/bureau-sdk';
import { bureauTransport, type BureauClientConnection } from './bureau-transport.ts';

export type { BureauDryRunOutput, BureauEvent, BureauInput, BureauOutput };

export function createBureauClient(connection: BureauClientConnection) {
  return createBureauClientWithTransport(bureauTransport(connection), connection);
}

export const bureauClient = createBureauClient({ baseUrl: '' });

type OptionalKeys<Value> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? Key : never;
}[keyof Value];

export type WithUndefined<Value> = Value extends unknown
  ? {
      [Key in keyof Value as Key extends OptionalKeys<Value> ? never : Key]: Value[Key];
    } & { [Key in OptionalKeys<Value>]?: Value[Key] | undefined }
  : never;
