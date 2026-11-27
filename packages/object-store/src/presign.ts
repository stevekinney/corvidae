import { sha256HexSync } from '@lostgradient/cryptography';
import { createHmac } from 'node:crypto';

export type PresignMethod = 'GET' | 'PUT' | 'DELETE' | 'HEAD' | 'POST';
export type PresignOptions = {
  readonly method?: PresignMethod;
  readonly expiresIn?: number;
  readonly bucket?: string;
  readonly query?: Readonly<Record<string, string>>;
};
export type ObjectPresigner = (key: string, options?: PresignOptions) => string;
export type SigV4PresignerOptions = {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  readonly bucket: string;
  readonly now?: () => Date;
};

const ALGORITHM = 'AWS4-HMAC-SHA256';
const MAXIMUM_EXPIRES_IN_SECONDS = 604_800;

function encodeComponent(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}
function compare(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Create a path-style AWS Signature Version 4 query presigner without reading process state. */
export function createSigV4Presigner(options: SigV4PresignerOptions): ObjectPresigner {
  const { region, accessKeyId, secretAccessKey, sessionToken, bucket: defaultBucket } = options;
  const now = options.now ?? (() => new Date());
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new TypeError('The endpoint is not a valid URL.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new TypeError('The endpoint must be an http or https URL.');
  }
  const origin = endpoint.origin;
  const host = endpoint.host;
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  return (key, presign = {}) => {
    const method = presign.method ?? 'GET';
    const expiresIn = presign.expiresIn ?? 86_400;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAXIMUM_EXPIRES_IN_SECONDS) {
      throw new RangeError('expiresIn must be a whole number of seconds from 1 to 604800.');
    }
    const bucket = presign.bucket ?? defaultBucket;
    const keyPath = key === '' ? '' : `/${key.split('/').map(encodeComponent).join('/')}`;
    const path = `${basePath}/${encodeComponent(bucket)}${keyPath}`;
    const time = amzDate(now());
    const day = time.slice(0, 8);
    const scope = `${day}/${region}/s3/aws4_request`;
    const parameters: [string, string][] = [
      ['X-Amz-Algorithm', ALGORITHM],
      ['X-Amz-Credential', `${accessKeyId}/${scope}`],
      ['X-Amz-Date', time],
      ['X-Amz-Expires', String(expiresIn)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    if (sessionToken !== undefined) parameters.push(['X-Amz-Security-Token', sessionToken]);
    for (const [name, value] of Object.entries(presign.query ?? {})) parameters.push([name, value]);
    const encoded = parameters
      .map(([name, value]) => [encodeComponent(name), encodeComponent(value)] as const)
      .toSorted(([leftName, leftValue], [rightName, rightValue]) =>
        leftName === rightName ? compare(leftValue, rightValue) : compare(leftName, rightName),
      );
    const canonicalQuery = encoded.map(([name, value]) => `${name}=${value}`).join('&');
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [ALGORITHM, time, scope, sha256HexSync(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const query = [...encoded, ['X-Amz-Signature', signature] as const]
      .toSorted(([left], [right]) => compare(left, right))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    return `${origin}${path}?${query}`;
  };
}
