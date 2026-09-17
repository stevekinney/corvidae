import matter from 'gray-matter';

import type { SkillContent, SkillMetadata } from './types';

/**
 * Error thrown when a SKILL.md file cannot be parsed.
 * Wraps the underlying parse failure in `cause` for debugging.
 */
export class SkillParseError extends Error {
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'SkillParseError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Pattern for valid skill names: kebab-case identifiers starting with a
 * lowercase letter, e.g. "code-review", "deploy", "my-skill-2".
 */
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Returns true when `name` is a valid kebab-case skill name.
 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/**
 * Attempts to parse YAML frontmatter from a markdown string.
 * If strict parsing fails (e.g., unquoted colons), retries with a lenient
 * strategy that wraps problematic values in quotes.
 */
function extractFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  try {
    const result = matter(content);
    return { data: result.data, body: result.content };
  } catch (strictError) {
    // Lenient retry: wrap values containing unquoted colons in quotes
    try {
      const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fenceMatch?.[1]) {
        throw strictError;
      }

      const yamlBlock = fenceMatch[1];
      const fixedLines = yamlBlock.split('\n').map((line) => {
        // Only fix top-level key-value lines (not indented/nested)
        const match = line.match(/^([a-zA-Z][\w-]*?):\s+(.+)$/);
        if (
          match?.[2] &&
          match[2].includes(':') &&
          !match[2].startsWith('"') &&
          !match[2].startsWith("'")
        ) {
          return `${match[1]}: "${match[2].replace(/"/g, '\\"')}"`;
        }
        return line;
      });

      const fixedContent = content.replace(
        /^---\r?\n[\s\S]*?\r?\n---/,
        `---\n${fixedLines.join('\n')}\n---`,
      );

      const result = matter(fixedContent);
      return { data: result.data, body: result.content };
    } catch {
      throw new SkillParseError(
        'Failed to parse SKILL.md frontmatter',
        strictError instanceof Error ? strictError : new Error(String(strictError)),
      );
    }
  }
}

/**
 * Parses a tool list from YAML frontmatter. Handles both comma-separated
 * strings ("Read, Grep, Glob") and YAML arrays (["Read", "Grep", "Glob"]).
 */
function parseToolList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }

  return [];
}

function requiredMetadata(data: Record<string, unknown>): SkillMetadata {
  const name = typeof data['name'] === 'string' ? data['name'].trim() : '';
  const description = typeof data['description'] === 'string' ? data['description'].trim() : '';
  if (!name)
    throw new SkillParseError('SKILL.md is missing a required "name" field in frontmatter.');
  if (!isValidSkillName(name)) {
    throw new SkillParseError(
      `Skill name "${name}" is not valid kebab-case. Names must match ${SKILL_NAME_PATTERN.source}`,
    );
  }
  if (!description) {
    throw new SkillParseError('SKILL.md is missing a required "description" field in frontmatter.');
  }
  return { name, description };
}

function optionalMetadata(data: Record<string, unknown>, metadata: SkillMetadata): void {
  const license = data['license'];
  const compatibility = data['compatibility'];
  if (typeof license === 'string' && license.trim()) metadata.license = license.trim();
  if (typeof compatibility === 'string' && compatibility.trim()) {
    metadata.compatibility = compatibility.trim();
  }
}

function addToolPolicy(data: Record<string, unknown>, metadata: SkillMetadata): void {
  const allowList = parseToolList(data['allowed-tools']);
  const denyList = parseToolList(data['denied-tools']);
  if (allowList.length === 0 && denyList.length === 0) return;
  metadata.toolPolicy = {
    ...(allowList.length > 0 ? { allowList } : {}),
    ...(denyList.length > 0 ? { denyList } : {}),
  };
}

function addCustomMetadata(data: Record<string, unknown>, metadata: SkillMetadata): void {
  const rawMetadata = data['metadata'];
  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) return;
  const record = Object.fromEntries(
    Object.entries(rawMetadata).map(([key, value]) => [key, String(value)]),
  );
  if (Object.keys(record).length > 0) metadata.metadata = record;
}

/**
 * Parses a SKILL.md string into structured `SkillContent`.
 *
 * Extracts YAML frontmatter for metadata and the markdown body for instructions.
 * `name` and `description` are required fields — throws `SkillParseError` if missing or empty.
 *
 * @param content - The raw SKILL.md file content.
 * @returns Parsed skill content with metadata and body.
 * @throws {SkillParseError} If required fields are missing or YAML is unparseable.
 */
export function parseSkillMarkdown(content: string): SkillContent {
  const { data, body } = extractFrontmatter(content);
  const metadata = requiredMetadata(data);
  optionalMetadata(data, metadata);
  addToolPolicy(data, metadata);
  addCustomMetadata(data, metadata);

  return {
    metadata,
    body: body.trim(),
  };
}

/**
 * Serializes a `SkillContent` back into a valid SKILL.md string.
 *
 * Produces YAML frontmatter delimited by `---` followed by the markdown body.
 * Maps `toolPolicy.allowList` back to the `allowed-tools` frontmatter key.
 *
 * @param content - The structured skill content to serialize.
 * @returns A SKILL.md-formatted string.
 */
export function serializeSkillMarkdown(content: SkillContent): string {
  const { metadata, body } = content;
  const frontmatterData = serializeMetadata(metadata);
  const serialized = matter.stringify(body ? `\n${body}\n` : '', frontmatterData);
  return serialized;
}

function serializeMetadata(metadata: SkillMetadata): Record<string, unknown> {
  const frontmatterData: Record<string, unknown> = {
    name: metadata.name,
    description: metadata.description,
  };
  addOptionalSerializedMetadata(frontmatterData, metadata);
  return frontmatterData;
}

function addOptionalSerializedMetadata(
  frontmatterData: Record<string, unknown>,
  metadata: SkillMetadata,
): void {
  if (metadata.license) frontmatterData['license'] = metadata.license;
  if (metadata.compatibility) frontmatterData['compatibility'] = metadata.compatibility;
  addSerializedToolPolicy(frontmatterData, metadata);
  addSerializedCustomMetadata(frontmatterData, metadata);
}

function addSerializedToolPolicy(
  frontmatterData: Record<string, unknown>,
  metadata: SkillMetadata,
): void {
  const allowList = metadata.toolPolicy?.allowList;
  if (allowList?.length) frontmatterData['allowed-tools'] = allowList.join(', ');
  const denyList = metadata.toolPolicy?.denyList;
  if (denyList?.length) frontmatterData['denied-tools'] = denyList.join(', ');
}

function addSerializedCustomMetadata(
  frontmatterData: Record<string, unknown>,
  metadata: SkillMetadata,
): void {
  if (metadata.metadata && Object.keys(metadata.metadata).length > 0) {
    frontmatterData['metadata'] = metadata.metadata;
  }
}
