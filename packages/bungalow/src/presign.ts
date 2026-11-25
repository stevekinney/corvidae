/**
 * An AWS Signature Version 4 query presigner for S3-compatible stores, over `node:crypto`, which
 * Bun and Node both provide. It is synchronous, as `Bun.S3Client.presign` is, so a caller can sign
 * inline before a `fetch`, and it reads nothing from the process: every credential comes from the
 * options it is built with. Requests are path-style: `<endpoint>/<bucket>/<key>`.
 *
 * @module presign
 */
import { createHash, createHmac } from 'node:crypto';

/** The HTTP methods a presigned URL can be made for. */
export type PresignMethod = 'GET' | 'PUT' | 'DELETE' | 'HEAD' | 'POST';

/** What one presigned URL is for. */
export type PresignOptions = {
  /** Defaults to `GET`. */
  readonly method?: PresignMethod;
  /** How long the URL stays valid, in seconds. Defaults to 86400, as `Bun.S3Client.presign` does. */
  readonly expiresIn?: number;
  /** The bucket to address instead of the presigner's own. */
  readonly bucket?: string;
  /** Extra query parameters to sign, such as `list-type=2` for a listing. */
  readonly query?: Readonly<Record<string, string>>;
};

/**
 * Sign one request to `key` and return its URL. An empty key addresses the bucket itself, which is
 * how a listing is made. A presigner must not throw a message that quotes a credential.
 */
export type ObjectPresigner = (key: string, options?: PresignOptions) => string;

/** What {@link createSigV4Presigner} signs with. */
export type SigV4PresignerOptions = {
  /** The store's base URL, such as `https://s3.us-east-1.amazonaws.com`. A path is kept as a base. */
  readonly endpoint: string;
  /** The signing region, such as `us-east-1` or `auto`. */
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Signed into every URL as `X-Amz-Security-Token` when set; never read from the environment. */
  readonly sessionToken?: string | undefined;
  /** The bucket a request addresses unless its options name another. */
  readonly bucket: string;
  /** The signing time. Defaults to the system clock; a test pins it. */
  readonly now?: () => Date;
};

const ALGORITHM = 'AWS4-HMAC-SHA256';
const DEFAULT_EXPIRES_IN_SECONDS = 86_400;
/** The longest a SigV4 presigned URL may be valid: seven days. */
const MAXIMUM_EXPIRES_IN_SECONDS = 604_800;

/** RFC 3986 percent-encoding, which SigV4 requires: only `A-Z a-z 0-9 - _ . ~` stay as they are. */
function encodeComponent(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `20261125T184601Z`: the ISO 8601 basic format SigV4 signs. */
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * A presigner that signs with the given credentials. The endpoint is parsed once, here; a parse
 * failure throws a `TypeError` that does not quote the endpoint.
 */
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
  // `URL.host` leaves out a default port, as the `host` header a `fetch` sends does.
  const host = endpoint.host;
  const basePath = endpoint.pathname.replace(/\/+$/, '');

  return (key, presign = {}) => {
    const method = presign.method ?? 'GET';
    const expiresIn = presign.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;
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
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
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
    const stringToSign = [ALGORITHM, time, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const query = [...encoded, ['X-Amz-Signature', signature] as const]
      .sort(([left], [right]) => compare(left, right))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    return `${origin}${path}?${query}`;
  };
}

/** Byte-order comparison, which SigV4's canonical query sort uses; the encoded text is ASCII. */
function compare(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
