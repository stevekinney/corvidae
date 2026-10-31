export type ToolId = string;

export type ToolIdentity = {
  namespace: string;
  name: string;
  version?: string;
};

export type ToolIdentityInput =
  | ToolId
  | ToolIdentity
  | {
      namespace?: string;
      name: string;
      version?: string;
    };

const DEFAULT_NAMESPACE = 'default';

export function formatToolId(identity: ToolIdentityInput): ToolId {
  const normalized = normalizeIdentity(identity);
  const namespace = encodeURIComponent(normalized.namespace);
  const name = encodeURIComponent(normalized.name);
  const version = normalized.version ? `@${encodeURIComponent(normalized.version)}` : '';
  return `${namespace}:${name}${version}`;
}

/**
 * The name a tool is reported by wherever it leaves Armorer: a result's, an approval's and a
 * policy context's `toolName`, and the refusals and events built from them (COR-1879). A tool in
 * the default namespace is reported by its bare name, as it always was; a tool in any other
 * namespace by its unversioned id (`namespace:name`), so `a:search` and `b:search` never share
 * one name in a grant, a policy decision or a saved record.
 */
export function formatToolName(identity: Pick<ToolIdentity, 'namespace' | 'name'>): string {
  return identity.namespace === DEFAULT_NAMESPACE
    ? identity.name
    : formatToolId({ namespace: identity.namespace, name: identity.name });
}

export function parseToolId(id: ToolId): ToolIdentity {
  if (typeof id !== 'string') {
    throw new TypeError('ToolId must be a string');
  }
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error('ToolId must not be empty');
  }

  const [namespacePart, nameAndVersion] = splitOnce(trimmed, ':');
  if (!nameAndVersion) {
    return normalizeIdentity({ name: decodeURIComponent(namespacePart) });
  }

  const [namePart, versionPart] = splitOnce(nameAndVersion, '@');
  const namespace = decodeURIComponent(namespacePart);
  const name = decodeURIComponent(namePart);
  const version = versionPart ? decodeURIComponent(versionPart) : undefined;

  return normalizeIdentity({
    namespace,
    name,
    ...(version !== undefined ? { version } : {}),
  });
}

export function normalizeIdentity(input: ToolIdentityInput): ToolIdentity {
  if (typeof input === 'string') {
    return parseToolId(input);
  }
  const namespace = typeof input.namespace === 'string' ? input.namespace.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const version = typeof input.version === 'string' ? input.version.trim() : undefined;

  if (!name) {
    throw new Error('Tool identity requires a name');
  }

  return {
    namespace: namespace || DEFAULT_NAMESPACE,
    name,
    ...(version ? { version } : {}),
  };
}

function splitOnce(value: string, delimiter: string): [string, string | undefined] {
  const index = value.indexOf(delimiter);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + delimiter.length)];
}
