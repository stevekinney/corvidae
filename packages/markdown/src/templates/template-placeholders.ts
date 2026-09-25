/**
 * Template placeholder domain logic for saved-prompt/template authoring.
 *
 * Pure functions for {{path}} token parsing, validation against known paths,
 * and deterministic template resolution. Catalog extraction lives in
 * `placeholder-schema-catalog.ts` and `placeholder-catalog.ts` and is
 * re-exported here as part of this module's public surface.
 *
 * DEP-582: No ProseMirror or DOM dependencies.
 * DEP-625: For secure markdown rendering with sanitization, use renderTemplate from template-render.ts
 */

import { isBlockedSegment } from './placeholder-security.js';
import type {
  PlaceholderCandidate,
  PlaceholderResolutionResult,
  PlaceholderToken,
  PlaceholderValidationIssue,
  PlaceholderValidationResult,
} from './types.js';

export { normalizePlaceholderDefinitions } from './placeholder-catalog.js';
export { buildPlaceholderCandidatesFromJsonSchema } from './placeholder-schema-catalog.js';

/** Valid placeholder path pattern: dot-separated identifiers starting with letter or underscore */
const PATH_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Traverse a nested object by dot-separated path segments.
 * Returns undefined if any segment is missing or a non-object intermediate is encountered.
 *
 * DEP-625: Hardened against prototype pollution attacks.
 * - Validates all segments before resolution using isBlockedSegment()
 * - Uses Object.hasOwn() to prevent prototype chain traversal
 *
 * This function enforces the same identifier rules as PATH_REGEX/PLACEHOLDER_SEGMENT_PATTERN
 * to ensure resolution behavior matches validation/candidate generation.
 */
function getNestedValue(values: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');

  // Validate all segments before resolution (DEP-625)
  for (const segment of segments) {
    if (isBlockedSegment(segment)) {
      return undefined;
    }
  }

  // Traverse the path using validated segments
  let current: unknown = values;

  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    // Use Object.hasOwn to avoid traversing the prototype chain. Without this
    // guard, paths like "constructor" or "toString" resolve to inherited
    // functions, which JSON.stringify coerces to the literal text "undefined"
    // instead of the expected empty string.
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

/**
 * Format a value for placeholder replacement using strict coercion rules.
 *
 * - undefined/null → ''
 * - function/symbol → '' (JSON.stringify returns undefined for these types,
 *   which string concatenation coerces to the literal text "undefined")
 * - string → unchanged
 * - number/boolean/bigint → String(value)
 * - array → map items then join(', ')
 * - object → JSON.stringify(value)
 */
function formatValueForReplacement(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  // JSON.stringify returns undefined (not a string) for function and symbol
  // values. String concatenation then coerces that to the literal text
  // "undefined" rather than the expected empty string.
  if (typeof value === 'function' || typeof value === 'symbol') {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) {
          return '';
        }
        // Mirror the top-level function/symbol guard: JSON.stringify returns
        // undefined for these types, and String() produces function source code
        // or "Symbol(...)" — both inconsistent with the documented '' contract.
        if (typeof item === 'function' || typeof item === 'symbol') {
          return '';
        }
        if (typeof item === 'object') {
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join(', ');
  }

  return JSON.stringify(value);
}

/**
 * Parse all {{...}} tokens from the given text with source offsets.
 *
 * Scans for {{ delimiters and extracts tokens with:
 * - raw: full text including delimiters
 * - path: trimmed body between delimiters
 * - startOffset/endOffset: source positions
 * - closed: whether the token has a closing }}
 *
 * Never throws for any input.
 */
export function parsePlaceholderTokens(text: string): PlaceholderToken[] {
  const tokens: PlaceholderToken[] = [];
  let position = 0;

  while (position < text.length) {
    const openIndex = text.indexOf('{{', position);

    if (openIndex === -1) {
      break;
    }

    const closeIndex = text.indexOf('}}', openIndex + 2);

    if (closeIndex !== -1) {
      const raw = text.slice(openIndex, closeIndex + 2);
      const path = raw.slice(2, -2).trim();
      tokens.push({
        raw,
        path,
        startOffset: openIndex,
        endOffset: closeIndex + 2,
        closed: true,
      });
      position = closeIndex + 2;
    } else {
      const raw = text.slice(openIndex);
      const path = raw.slice(2).trim();
      tokens.push({
        raw,
        path,
        startOffset: openIndex,
        endOffset: text.length,
        closed: false,
      });
      break;
    }
  }

  return tokens;
}

/**
 * Validate parsed tokens against a set of known placeholder candidates.
 *
 * Classifies each token as valid or invalid:
 * - Unclosed tokens → malformed_token
 * - Invalid path format → invalid_path_format
 * - Path not in candidate set → unknown_placeholder
 * - Otherwise → valid
 */
export function validatePlaceholderTokens(
  tokens: PlaceholderToken[],
  candidates: PlaceholderCandidate[],
): PlaceholderValidationResult {
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
  const validTokens: PlaceholderToken[] = [];
  const invalidTokens: PlaceholderToken[] = [];
  const issues: PlaceholderValidationIssue[] = [];

  for (const token of tokens) {
    if (!token.closed) {
      invalidTokens.push(token);
      issues.push({ token, reason: 'malformed_token' });
    } else if (!PATH_REGEX.test(token.path)) {
      invalidTokens.push(token);
      issues.push({ token, reason: 'invalid_path_format' });
    } else if (!candidatePaths.has(token.path)) {
      invalidTokens.push(token);
      issues.push({ token, reason: 'unknown_placeholder' });
    } else {
      validTokens.push(token);
    }
  }

  return { validTokens, invalidTokens, issues };
}

/**
 * Resolve all placeholder tokens in the given text by substituting values.
 *
 * Iterates tokens in reverse order to preserve earlier offsets during string splicing.
 * Unclosed tokens are left in the text unmodified.
 * When candidatePaths is provided, unknown paths are reported as issues.
 */
export function resolveTemplatePlaceholders(
  text: string,
  values: Record<string, unknown>,
  candidatePaths?: string[],
): PlaceholderResolutionResult {
  const tokens = parsePlaceholderTokens(text);
  const candidateSet = candidatePaths ? new Set(candidatePaths) : undefined;
  const issues: PlaceholderValidationIssue[] = [];

  // Iterate in reverse to preserve offsets during splicing. Issues are
  // collected in reverse traversal order and sorted by startOffset before
  // return so downstream consumers receive them in forward document order,
  // consistent with validatePlaceholderTokens.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (!token) continue;

    if (!token.closed) {
      continue;
    }

    const value = getNestedValue(values, token.path);
    const replacement = formatValueForReplacement(value);
    text = text.slice(0, token.startOffset) + replacement + text.slice(token.endOffset);

    if (candidateSet && !candidateSet.has(token.path) && PATH_REGEX.test(token.path)) {
      issues.push({ token, reason: 'unknown_placeholder' });
    }
  }

  // Sort issues in forward document order so callers receive a consistent
  // ordering regardless of whether they came from this function (which
  // traverses tokens in reverse) or validatePlaceholderTokens (which
  // traverses forward).
  const sortedIssues = issues.toSorted((a, b) => a.token.startOffset - b.token.startOffset);

  return { text, issues: sortedIssues };
}
