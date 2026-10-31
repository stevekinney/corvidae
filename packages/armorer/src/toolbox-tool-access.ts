import { fromNamespacedToolName } from './adapters/provider-tool-names';
import type { ToolId } from './core/identity';
import type { Tool } from './is-tool';

/**
 * Why {@link Toolbox.resolveTool} could not return exactly one tool.
 *
 * - `missing`: nothing registered matches the name or id.
 * - `ambiguous`: more than one tool matches, so picking one would be a guess. A bare name shared
 *   by two namespaces, and a versionless `namespace:name` that several versions answer to, both
 *   land here.
 * - `version-mismatch`: the reference pins a version and the toolbox holds the same namespace and
 *   name at other versions only.
 */
export type ToolResolutionFailureReason = 'missing' | 'ambiguous' | 'version-mismatch';

/**
 * The outcome of {@link Toolbox.resolveTool}: the one tool that matched, or the reason none did.
 */
export type ToolResolution<TTool extends Tool = Tool> =
  | {
      /** The reference named exactly one registered tool. */
      readonly ok: true;
      /** The tool the reference resolved to. */
      readonly tool: TTool;
    }
  | {
      /** The reference did not name exactly one registered tool. */
      readonly ok: false;
      /** Why no tool was returned. */
      readonly reason: ToolResolutionFailureReason;
      /**
       * The ids of the registered tools that came closest: every match for `ambiguous`, every
       * version of the namespaced name for `version-mismatch`, and empty for `missing`.
       */
      readonly candidates: readonly ToolId[];
    };

const MISSING: ToolResolution = Object.freeze({
  ok: false,
  reason: 'missing',
  candidates: Object.freeze<ToolId[]>([]),
});

function failure(
  reason: ToolResolutionFailureReason,
  candidates: readonly Tool[],
): ToolResolution<never> {
  return { ok: false, reason, candidates: candidates.map((tool) => tool.id) };
}

function resolveBareName(
  toolsByName: ReadonlyMap<string, readonly Tool[]>,
  name: string,
): ToolResolution {
  const matches = toolsByName.get(name) ?? [];
  if (matches.length === 0) return MISSING;
  const [only] = matches;
  if (matches.length === 1 && only) return { ok: true, tool: only };
  return failure('ambiguous', matches);
}

type NamespacedReference = { namespace: string; name: string; version: string | undefined };

/** Reads `namespace:name[@version]` the way `formatToolId` writes it; `undefined` when malformed. */
function readNamespacedReference(reference: string): NamespacedReference | undefined {
  const separator = reference.indexOf(':');
  const rest = reference.slice(separator + 1);
  const versionSeparator = rest.indexOf('@');
  const encodedName = versionSeparator === -1 ? rest : rest.slice(0, versionSeparator);
  const encodedVersion = versionSeparator === -1 ? undefined : rest.slice(versionSeparator + 1);
  if (separator < 1 || !encodedName || encodedVersion === '') return undefined;
  try {
    return {
      namespace: decodeURIComponent(reference.slice(0, separator)),
      name: decodeURIComponent(encodedName),
      version: encodedVersion === undefined ? undefined : decodeURIComponent(encodedVersion),
    };
  } catch {
    return undefined;
  }
}

function resolveNamespaced(
  toolsByName: ReadonlyMap<string, readonly Tool[]>,
  reference: string,
): ToolResolution | undefined {
  const parsed = readNamespacedReference(reference);
  if (!parsed) return undefined;
  const sameName = (toolsByName.get(parsed.name) ?? []).filter(
    (tool) => tool.identity.namespace === parsed.namespace,
  );
  if (sameName.length === 0) return undefined;
  const candidates =
    parsed.version === undefined
      ? sameName
      : sameName.filter((tool) => tool.identity.version === parsed.version);
  const [only] = candidates;
  if (candidates.length === 1 && only) return { ok: true, tool: only };
  if (candidates.length === 0) return failure('version-mismatch', sameName);
  return failure('ambiguous', candidates);
}

/**
 * Reads `namespace__name`, the name the adapters give a namespaced tool, as that tool. `undefined`
 * when the name has no `__` or no tool in that namespace has that name.
 */
function resolveProviderName(
  toolsByName: ReadonlyMap<string, readonly Tool[]>,
  name: string,
): ToolResolution | undefined {
  const parsed = fromNamespacedToolName(name);
  if (!parsed) return undefined;
  const matches = (toolsByName.get(parsed.name) ?? []).filter(
    (tool) => tool.identity.namespace === parsed.namespace,
  );
  if (matches.length === 0) return undefined;
  const [only] = matches;
  return matches.length === 1 && only ? { ok: true, tool: only } : failure('ambiguous', matches);
}

/**
 * Builds the lookup behind `Toolbox.resolveTool`.
 *
 * An exact registered id always wins. A reference with a `:` is read as `namespace:name`, with an
 * optional `@version`; anything else is a bare name. A registered name that itself contains a `:`
 * still resolves as a bare name when no namespaced tool answers to it. A bare name nothing is
 * registered under is then read as `namespace__name`, the name a provider calls a namespaced tool
 * by (`toNamespacedToolName`), so a registered bare name that contains `__` always wins. The
 * resolver never throws: a reference that cannot be parsed is `missing`.
 */
export function createToolResolver(
  toolsById: ReadonlyMap<string, Tool>,
  toolsByName: ReadonlyMap<string, readonly Tool[]>,
): (idOrName: string) => ToolResolution {
  return (idOrName) => {
    const exact = toolsById.get(idOrName);
    if (exact) return { ok: true, tool: exact };
    if (typeof idOrName !== 'string') return MISSING;
    const namespaced = idOrName.includes(':')
      ? resolveNamespaced(toolsByName, idOrName)
      : undefined;
    if (namespaced) return namespaced;
    const bare = resolveBareName(toolsByName, idOrName);
    if (bare.ok || bare.reason !== 'missing') return bare;
    return resolveProviderName(toolsByName, idOrName) ?? bare;
  };
}

/**
 * Builds `Toolbox.getTool` on top of the resolver: the tool when the reference names exactly one,
 * `undefined` for every other outcome.
 */
export function createToolAccessor(
  resolveTool: (idOrName: string) => ToolResolution,
): (nameOrId: string) => Tool | undefined {
  return (nameOrId) => {
    const resolution = resolveTool(nameOrId);
    return resolution.ok ? resolution.tool : undefined;
  };
}
