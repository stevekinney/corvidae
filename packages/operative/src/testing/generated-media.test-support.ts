import type {
  GeneratedMediaAdmission,
  GeneratedMediaAdmissionRequest,
  GeneratedMediaAdmitter,
  GeneratedMediaRetentionRequest,
  GeneratedMediaSettlement,
  ManagedAssetReference,
} from '../generated-media';
import type { CleanupAcknowledgement, ClosedOptions } from '../types';

/** What a scripted port does with each admission it is handed. */
export type ScriptedAdmissionMode = 'available' | 'reject' | 'manual';

export interface ScriptedAdmissionRecord {
  readonly request: GeneratedMediaAdmissionRequest;
  readonly source: ManagedAssetReference;
  aborted: boolean;
  settlement: GeneratedMediaSettlement | undefined;
  /** Settles a `manual` admission. Ignored once it has settled. */
  settle(settlement: GeneratedMediaSettlement): void;
}

export interface ScriptedMediaAdmitter {
  readonly port: GeneratedMediaAdmitter;
  readonly admissions: ScriptedAdmissionRecord[];
  /** The size of each `admitAll` batch the port received; empty for a port with no batch call. */
  readonly batches: number[];
  /** Every `retainCommitted` call the port received; empty for a port with no retention call. */
  readonly retained: GeneratedMediaRetentionRequest[];
}

/**
 * An in-memory media-admission port for tests. `available` settles each admission at once
 * with a `managed-asset` source `asset-<n>`; `reject` settles it rejected; `manual` leaves
 * it pending until the test settles it, and an abort of the request signal settles it
 * `aborted`, as Bureau's asset service settles an aborted pending record.
 */
export function createScriptedMediaAdmitter(
  options: {
    mode?: ScriptedAdmissionMode;
    rejectionCode?: string;
    /** A port that does not honor the request signal: an abort leaves the admission pending. */
    ignoreAbort?: boolean;
    /** What each admission's `closed()` answers once it has settled; defaults to `completed`. */
    closedOutcome?: CleanupAcknowledgement;
    /** Called as each admission is accepted, so a test can wait for it without a timer. */
    onAdmit?: (record: ScriptedAdmissionRecord) => void;
    /** Overrides `mode` for the admission at this position (0-based, in acceptance order). */
    modeAt?: (position: number) => ScriptedAdmissionMode | undefined;
    /** Gives the port an `admitAll`, as Bureau's has, recording each batch's size. */
    batch?: boolean;
    /** Gives the port a `retainCommitted`, recording each call; `'fail'` makes it reject. */
    retention?: 'record' | 'fail';
  } = {},
): ScriptedMediaAdmitter {
  const {
    mode = 'available',
    rejectionCode = 'per-part-limit-exceeded',
    ignoreAbort = false,
    closedOutcome = { status: 'completed' },
    onAdmit,
    modeAt,
    batch = false,
    retention,
  } = options;
  const admissions: ScriptedAdmissionRecord[] = [];
  const batches: number[] = [];
  const retained: GeneratedMediaRetentionRequest[] = [];

  const port: GeneratedMediaAdmitter = {
    ...(retention === undefined
      ? {}
      : {
          async retainCommitted(request: GeneratedMediaRetentionRequest) {
            retained.push(request);
            if (retention === 'fail') throw new Error('retention unavailable');
          },
        }),
    ...(batch
      ? {
          async admitAll(requests: readonly GeneratedMediaAdmissionRequest[]) {
            batches.push(requests.length);
            const accepted: GeneratedMediaAdmission[] = [];
            for (const request of requests) accepted.push(await port.admit(request));
            return accepted;
          },
        }
      : {}),
    async admit(request): Promise<GeneratedMediaAdmission> {
      const position = admissions.length;
      const effectiveMode = modeAt?.(position) ?? mode;
      const source: ManagedAssetReference = {
        kind: 'managed-asset',
        assetId: `asset-${admissions.length + 1}`,
        revision: 1,
      };
      let resolveSettlement!: (settlement: GeneratedMediaSettlement) => void;
      const settled = new Promise<GeneratedMediaSettlement>((resolve) => {
        resolveSettlement = resolve;
      });
      const record: ScriptedAdmissionRecord = {
        request,
        source,
        aborted: false,
        settlement: undefined,
        settle(settlement) {
          if (record.settlement !== undefined) return;
          record.settlement = settlement;
          resolveSettlement(settlement);
        },
      };
      admissions.push(record);
      onAdmit?.(record);

      const abort = (reason = 'aborted'): void => {
        if (ignoreAbort) return;
        record.aborted = true;
        record.settle({ outcome: 'aborted', reason });
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', () => abort(), { once: true });

      if (effectiveMode === 'available') {
        record.settle({
          outcome: 'available',
          source,
          mimeType: request.part.mimeType ?? 'application/octet-stream',
        });
      } else if (effectiveMode === 'reject') {
        record.settle({ outcome: 'rejected', code: rejectionCode, message: 'refused by policy' });
      }

      return {
        source,
        settled: () => settled,
        abort,
        async closed(closeOptions?: ClosedOptions): Promise<CleanupAcknowledgement> {
          const signal = closeOptions?.signal;
          if (signal?.aborted) return { status: 'unresolved', reason: 'timed-out' };
          const abandoned = signal
            ? new Promise<'timed-out'>((resolve) => {
                signal.addEventListener('abort', () => resolve('timed-out'), { once: true });
              })
            : undefined;
          const outcome = await (abandoned ? Promise.race([settled, abandoned]) : settled);
          if (outcome === 'timed-out') return { status: 'unresolved', reason: 'timed-out' };
          return closedOutcome;
        },
      };
    },
  };

  return { port, admissions, batches, retained };
}
