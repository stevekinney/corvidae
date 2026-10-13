/** Admission policy defaults and resolution (COR-794). */
import type { AssetPolicy, AssetPolicyInput } from './types';

const MEBIBYTE = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

export const DEFAULT_ASSET_POLICY: AssetPolicy = Object.freeze({
  limits: Object.freeze([]),
  maxInlineBytes: 10 * MEBIBYTE,
  allowedMediaTypes: undefined,
  duplicatePolicy: 'store-separately',
  url: Object.freeze({
    allowedSchemes: Object.freeze(['https:']),
    allowPrivateNetwork: false,
    maxRedirects: 3,
    allowProviderFetch: false,
  }),
  defaultRetentionMilliseconds: undefined,
  tombstoneRetentionMilliseconds: 7 * 24 * HOUR,
  uploadSessionTtlMilliseconds: HOUR,
});

/** Fills `input` from {@link DEFAULT_ASSET_POLICY} and freezes the result. */
export function resolveAssetPolicy(input: AssetPolicyInput = {}): AssetPolicy {
  const { url, ...rest } = input;
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  ) as Partial<AssetPolicy>;
  const definedUrl = Object.fromEntries(
    Object.entries(url ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<AssetPolicy['url']>;
  return Object.freeze({
    ...DEFAULT_ASSET_POLICY,
    ...defined,
    limits: Object.freeze(
      (defined.limits ?? DEFAULT_ASSET_POLICY.limits).map((limit) => Object.freeze({ ...limit })),
    ),
    url: Object.freeze({ ...DEFAULT_ASSET_POLICY.url, ...definedUrl }),
  });
}
