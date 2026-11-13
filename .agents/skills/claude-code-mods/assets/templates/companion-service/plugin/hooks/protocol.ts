/**
 * The wire contract between the attention-queue mod and its companion service.
 * Pure TypeScript with no imports: the mod imports it by relative path, and the
 * Bun service imports the same file, so there is one definition of each shape.
 */

/** What `/health` must name for the mod to trust the service on the port. */
export const SERVICE_NAME = 'attention-queue';

/** Bump on any breaking change to a request or response below. */
export const PROTOCOL_VERSION = 1;

export const ATTENTION_KINDS = ['approval', 'failed-check', 'expired-claim', 'handoff'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** One thing that needs the person: an approval, a failed check, an expired claim, a handoff. */
export type AttentionItem = {
  /** Stable and chosen by the producer, so a resubmitted item replaces itself (deduplication). */
  id: string;
  kind: AttentionKind;
  title: string;
  /** Where it came from, such as `ci` or a session id. */
  source: string;
  createdAt: number;
  /** When a person acknowledged it here; `null` while it waits. */
  acknowledgedAt: number | null;
};

export type HealthResponse = { service: string; protocolVersion: number };

export type ItemsResponse = { items: AttentionItem[]; generatedAt: number };

/** A heartbeat: live presence, not history and not ownership. */
export type PresenceRequest = {
  /** The conversation; it changes after /clear. */
  sessionId: string;
  /** This loaded copy of the mod; it changes on every reload. */
  instanceId: string;
  /** Increases with each heartbeat from one instance, so a late duplicate can be ignored. */
  sequence: number;
  sentAt: number;
};

/** The file the service writes at startup and removes at shutdown. */
export type RuntimeFile = { url: string; token: string; protocolVersion: number; pid: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseHealth(value: unknown): HealthResponse | undefined {
  if (!isRecord(value) || typeof value.service !== 'string') return undefined;
  if (typeof value.protocolVersion !== 'number') return undefined;
  return { service: value.service, protocolVersion: value.protocolVersion };
}

export function parseItem(value: unknown): AttentionItem | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, title, source, createdAt, acknowledgedAt } = value;
  if (!isText(id, 128) || !isText(title, 500) || !isText(source, 128) || !isTime(createdAt)) {
    return undefined;
  }
  if (!ATTENTION_KINDS.includes(kind as AttentionKind)) return undefined;
  if (acknowledgedAt !== null && !isTime(acknowledgedAt)) return undefined;
  return { id, kind: kind as AttentionKind, title, source, createdAt, acknowledgedAt };
}

/** Parses a list response, dropping malformed items rather than failing the whole list. */
export function parseItems(value: unknown): ItemsResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || !isTime(value.generatedAt))
    return undefined;
  const items = value.items.flatMap((item) => {
    const parsed = parseItem(item);
    return parsed === undefined ? [] : [parsed];
  });
  return { items, generatedAt: value.generatedAt };
}

export function parsePresence(value: unknown): PresenceRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { sessionId, instanceId, sequence, sentAt } = value;
  if (!isText(sessionId, 128) || !isText(instanceId, 128)) return undefined;
  if (
    typeof sequence !== 'number' ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    !isTime(sentAt)
  ) {
    return undefined;
  }
  return { sessionId, instanceId, sequence, sentAt };
}

export function parseRuntimeFile(value: unknown): RuntimeFile | undefined {
  if (!isRecord(value)) return undefined;
  const { url, token, protocolVersion, pid } = value;
  if (!isText(url, 2048) || !isText(token, 512)) return undefined;
  if (typeof protocolVersion !== 'number' || typeof pid !== 'number') return undefined;
  return { url, token, protocolVersion, pid };
}

/** Whether the process answering `/health` is this service, speaking this protocol. */
export function compatibilityOf(
  health: HealthResponse | undefined,
): 'compatible' | 'not-this-service' | 'other-protocol' {
  if (health === undefined || health.service !== SERVICE_NAME) return 'not-this-service';
  return health.protocolVersion === PROTOCOL_VERSION ? 'compatible' : 'other-protocol';
}
