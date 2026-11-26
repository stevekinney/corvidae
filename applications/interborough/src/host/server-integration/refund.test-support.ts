import { textValueStore, type Storage } from '@lostgradient/storage';
import {
  validateApprovalBinding,
  type ApprovalBindingPayload,
  type ApprovalStateStore,
} from 'armorer';

export function durableApprovalStore(storage: Storage): ApprovalStateStore {
  const records = textValueStore(storage, { disposeUnderlyingStorage: false });
  const key = (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) =>
    `approval-fixture:${encodeURIComponent(binding.replayScope)}:${encodeURIComponent(binding.nonce)}`;
  const read = async (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) => {
    const raw = await records.get(key(binding));
    return raw === null
      ? undefined
      : { raw, value: JSON.parse(raw) as { state: string; binding: ApprovalBindingPayload } };
  };
  const change = async (
    binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>,
    from: readonly string[],
    to: string,
  ) => {
    const entry = await read(binding);
    if (
      !entry ||
      !from.includes(entry.value.state) ||
      !(await records.conditionalBatch(
        [{ key: key(binding), expectedValue: entry.raw }],
        [{ type: 'set', key: key(binding), value: JSON.stringify({ ...entry.value, state: to }) }],
      ))
    )
      throw new Error('Approval state conflict');
  };
  const store: ApprovalStateStore = {
    async issue(binding) {
      validateApprovalBinding(binding);
      if (
        !(await records.conditionalBatch(
          [{ key: key(binding), expectedValue: null }],
          [{ type: 'set', key: key(binding), value: JSON.stringify({ state: 'issued', binding }) }],
        ))
      )
        throw new Error('Approval already issued');
    },
    async reserve(binding, context, now) {
      validateApprovalBinding(binding, context, now);
      const entry = await read(binding);
      if (!entry || JSON.stringify(entry.value.binding) !== JSON.stringify(binding))
        throw new Error('Approval binding mismatch');
      await change(binding, ['issued'], 'reserved');
    },
    async commit(binding) {
      await change(binding, ['reserved'], 'consumed');
    },
    async release(binding) {
      const entry = await read(binding);
      if (entry && ['reserved', 'consumed'].includes(entry.value.state))
        await change(binding, [entry.value.state], 'issued');
    },
    async consume(binding, context, now) {
      await store.reserve(binding, context, now);
      await store.commit(binding);
    },
    async revoke(binding) {
      await change(binding, ['issued', 'reserved'], 'revoked');
    },
    async state(binding) {
      const entry = await read(binding);
      return entry && entry.value.state !== 'reserved'
        ? (entry.value.state as 'issued' | 'consumed' | 'revoked')
        : undefined;
    },
  };
  return store;
}
