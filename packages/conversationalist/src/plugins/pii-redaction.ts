import { ConversationalistError } from '../errors';
import { readMediaBody } from '../media-body';
import {
  isMediaContent,
  type MediaContent,
  type MultiModalContent,
  type ToolResultPart,
} from '../multi-modal';
import type { JSONValue, MessageInput, MessagePlugin } from '../types';

/**
 * Default regex rules for redacting common PII.
 *
 * The email and apiKey patterns begin with a lookbehind that forbids a match from
 * starting inside a run of their leading character class, and apiKey also looks
 * ahead for the `:` or `=` that must end that run. A match can only begin at the
 * start of a run, so a long unbroken token is scanned once instead of once per
 * start position (COR-1753). The email pattern also allows a start right after a
 * previous email match (`a@b.co_c@d.ef` holds two), recognised by a bounded
 * lookbehind on a hostname of at most 253 characters. The leftmost match is
 * otherwise unchanged.
 */
export const DEFAULT_PII_RULES = {
  email: {
    regex:
      /(?:(?<![a-zA-Z0-9._%+-])|(?=[0-9._%+-])(?<=@[a-zA-Z0-9.-]{0,253}\.[a-zA-Z]{2,}))[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: '[EMAIL_REDACTED]',
  },
  phone: {
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replace: '[PHONE_REDACTED]',
  },
  apiKey: {
    regex:
      /(?<![a-zA-Z0-9_-])(?=[a-zA-Z0-9_-]*[:=])(?:[a-zA-Z0-9_-]*(?:api|key|secret|token|password|auth)[a-zA-Z0-9_-]*[:=]\s*["']?)([a-zA-Z0-9._-]{16,})(?:["']?)/gi,
    replace: (match: string, key: string) => match.replace(key, '[KEY_REDACTED]'),
  },
} as const;

/**
 * A single PII redaction rule.
 */
export interface PIIRedactionRule {
  regex: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Options for configuring PII redaction.
 */
export interface PIIRedactionOptions {
  rules?: Record<string, PIIRedactionRule>;
  excludeRules?: string[];
}

/**
 * Creates a PII redaction function with custom rules.
 */
export function createPIIRedaction(options: PIIRedactionOptions = {}): (text: string) => string {
  const rules = { ...DEFAULT_PII_RULES, ...options.rules };
  const activeRules = Object.entries(rules).filter(
    ([name]) => !options.excludeRules?.includes(name),
  );

  return (text: string): string => {
    let result = text;
    for (const [, rule] of activeRules) {
      const replacer = rule.replace;
      result =
        typeof replacer === 'string'
          ? result.replace(rule.regex, replacer)
          : result.replace(rule.regex, replacer);
    }
    return result;
  };
}

/**
 * Recursively redacts string leaves in a JSON value using the provided redaction function.
 */
function redactJSONValue(value: JSONValue, redact: (text: string) => string): JSONValue {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (isJSONArray(value)) return value.map((item) => redactJSONValue(item, redact));
  return redactJSONRecord(value, redact);
}

function isJSONArray(value: JSONValue): value is readonly JSONValue[] {
  return Array.isArray(value);
}

function redactJSONRecord(
  value: Record<string, JSONValue>,
  redact: (text: string) => string,
): Record<string, JSONValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactJSONValue(nested, redact)]),
  );
}

/**
 * Redacts the text a media part carries: its name, alt text, caption,
 * transcript, extracted text, and metadata strings, and the body of a source a
 * provider reads as characters (inline UTF-8, inline base64 or a data URL under
 * a textual media type), re-encoded the way it was stored. A text body that does
 * not decode is refused: passing it through would send a provider text this
 * plugin never read. Binary sources and locators identify bytes, not prose, and
 * stay byte-for-byte intact.
 */
function redactMediaFields(
  part: MediaContent,
  redact: (text: string) => string,
  partIndex: number,
): MediaContent {
  let redacted: MediaContent = { ...part };
  for (const field of MEDIA_TEXT_FIELDS) {
    const value = part[field];
    if (value !== undefined) redacted[field] = redact(value);
  }
  if (part.metadata !== undefined) {
    const metadata = redactJSONValue(part.metadata, redact);
    if (typeof metadata === 'object' && metadata !== null && !isJSONArray(metadata)) {
      redacted.metadata = metadata;
    }
  }
  const body = readMediaBody(part);
  if (body.status === 'undecodable') {
    throw new ConversationalistError(
      'error:validation',
      `Cannot redact ${part.type} part ${partIndex}: ${body.reason}`,
      { context: { partIndex, partType: part.type } },
    );
  }
  if (body.status === 'text' && body.body.withText !== undefined) {
    // Only a changed body is re-encoded: putting an unchanged one back would
    // alter bytes that had nothing to redact (a byte-order mark, the
    // percent-encoding of a data URL).
    const text = redact(body.body.text);
    if (text !== body.body.text) {
      redacted = { ...redacted, source: body.body.withText(text).source };
    }
  }
  return redacted;
}

const MEDIA_TEXT_FIELDS = ['name', 'alt', 'caption', 'transcript', 'extractedText'] as const;

function redactContentPart(
  part: MultiModalContent,
  redact: (text: string) => string,
  partIndex: number,
): MultiModalContent {
  if (part.type === 'text') {
    const text = part.text ? redact(part.text) : part.text;
    if (part.citations === undefined) return part.text ? { ...part, text } : part;
    return { ...part, text, citations: redactJSONValue(part.citations, redact) };
  }
  if (part.type === 'server_tool_use') {
    return { ...part, input: redactJSONValue(part.input, redact) };
  }
  if ('tool_use_id' in part) {
    return { ...part, content: redactJSONValue(part.content, redact) };
  }
  if (isMediaContent(part)) return redactMediaFields(part, redact, partIndex);
  // Signed thinking payloads must remain byte-for-byte intact for replay.
  return part;
}

/**
 * Creates a PII redaction plugin with custom rules.
 */
export function createPIIRedactionPlugin(options: PIIRedactionOptions = {}): MessagePlugin {
  const redact = createPIIRedaction(options);

  const transform = (input: MessageInput): MessageInput => {
    let result: MessageInput;

    if (typeof input.content === 'string') {
      result = {
        ...input,
        content: redact(input.content),
      };
    } else {
      result = {
        ...input,
        content: input.content.map((part, index) => redactContentPart(part, redact, index)),
      };
    }

    if (result.toolCall?.arguments !== undefined) {
      result = {
        ...result,
        toolCall: {
          ...result.toolCall,
          arguments: redactJSONValue(result.toolCall.arguments, redact),
        },
      };
    }

    if (result.toolResult?.content !== undefined) {
      result = {
        ...result,
        toolResult: {
          ...result.toolResult,
          content: redactJSONValue(result.toolResult.content, redact),
        },
      };
    }

    // A tool result's parts are payload too: their text and media fields are redacted alike.
    const parts = result.toolResult?.parts;
    if (result.toolResult !== undefined && parts !== undefined) {
      result = {
        ...result,
        toolResult: {
          ...result.toolResult,
          parts: parts.map(
            (part, index) => redactContentPart(part, redact, index) as ToolResultPart,
          ),
        },
      };
    }

    if (result.metadata !== undefined) {
      result = {
        ...result,
        metadata: redactJSONRecord(result.metadata, redact),
      };
    }

    return result;
  };
  return Object.assign(transform, { id: 'pii-redaction', revision: 1 });
}

/**
 * Default PII redaction plugin instance.
 */
export const redactPii = createPIIRedactionPlugin();
