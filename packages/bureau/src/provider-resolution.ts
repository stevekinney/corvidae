import { TypedEventTarget } from '@lostgradient/lifecycle';
import type {
  ProviderDefinition,
  StreamEventMap,
  GenerateFunction,
  DecisionModel,
} from '@lostgradient/operative';
import { withEnhancedStreaming, withCache } from '@lostgradient/operative';
import type { TextValueStore } from '@lostgradient/storage';
import { type ConversationHistory, getOwn } from 'conversationalist';
import type { ProviderConfiguration, StreamingConfiguration, CacheConfiguration } from './types';
import type { MediaRunOptions, SessionAgentRun } from './runtime-composition-types';

/**
 * Builds the generate function for a configured provider from the definitions a host registered.
 *
 * The definition whose `name` equals `configuration.provider` serves it: its `stream` method,
 * wrapped in enhanced streaming over `streamEventTarget`, when one is given, and its `generate`
 * method otherwise. The configuration reaches the definition whole, so a field the shared
 * configuration type does not name (an injected `client`, say) arrives unchanged.
 *
 * @throws {Error} When two definitions carry one name, whether or not the configuration selects
 * it, or when no definition carries `configuration.provider`.
 */
export function resolveProviderGenerate(
  definitions: readonly ProviderDefinition[],
  configuration: ProviderConfiguration,
  streamEventTarget: TypedEventTarget<StreamEventMap> | undefined,
  streamingConfiguration: StreamingConfiguration | undefined,
  pluginConfiguration?: unknown,
): GenerateFunction {
  const seen = new Set<string>();
  for (const { name } of definitions) {
    if (seen.has(name)) throw new Error(`Duplicate provider definition "${name}".`);
    seen.add(name);
  }
  const definition = definitions.find(({ name }) => name === configuration.provider);
  if (definition === undefined) {
    const registered = definitions.map(({ name }) => name).join(', ');
    throw new Error(
      `Unknown provider "${configuration.provider}". Registered providers: ${registered === '' ? 'none' : registered}.`,
    );
  }
  if (streamEventTarget === undefined) {
    if (definition.generate === undefined) {
      throw new TypeError(`Provider "${definition.name}" does not provide generate capability.`);
    }
    return definition.generate(configuration, pluginConfiguration);
  }
  if (definition.stream === undefined) {
    throw new TypeError(`Provider "${definition.name}" does not provide stream capability.`);
  }
  return withEnhancedStreaming(definition.stream(configuration, pluginConfiguration), {
    eventTarget: streamEventTarget,
    onTextDelta: streamingConfiguration?.onTextDelta,
  });
}
/** Builds the native decision model for a configured provider. */
export function resolveProviderDecide(
  definitions: readonly ProviderDefinition[],
  configuration: ProviderConfiguration,
  pluginConfiguration?: unknown,
): DecisionModel {
  const seen = new Set<string>();
  for (const { name } of definitions) {
    if (seen.has(name)) throw new Error(`Duplicate provider definition "${name}".`);
    seen.add(name);
  }
  const definition = definitions.find(({ name }) => name === configuration.provider);
  if (definition === undefined) {
    const registered = definitions.map(({ name }) => name).join(', ');
    throw new Error(
      `Unknown provider "${configuration.provider}". Registered providers: ${registered === '' ? 'none' : registered}.`,
    );
  }
  if (definition.decide === undefined) {
    throw new TypeError(`Provider "${definition.name}" does not provide decide capability.`);
  }
  return definition.decide(configuration, pluginConfiguration);
}
export function applyCache(
  generate: GenerateFunction,
  configuration: CacheConfiguration | undefined,
  store: TextValueStore | undefined,
): GenerateFunction {
  if (!configuration) {
    return generate;
  }

  const cacheStore = configuration.store ?? store;
  if (configuration.enabled === false || !cacheStore) {
    return generate;
  }

  return withCache(generate, {
    ...configuration,
    store: cacheStore,
  });
}
/**
 * The media options Bureau contributes to a run that already has its own: whichever of
 * the two the run left unset. An agent that supplied its own resolver or its own
 * unverified-asset policy keeps it.
 */
export function unsetMediaOptions(run: MediaRunOptions, bureau: MediaRunOptions): MediaRunOptions {
  return {
    ...(run.contentSourceResolver === undefined && bureau.contentSourceResolver !== undefined
      ? { contentSourceResolver: bureau.contentSourceResolver }
      : {}),
    ...(run.assetSafety === undefined && bureau.assetSafety !== undefined
      ? { assetSafety: bureau.assetSafety }
      : {}),
    ...(run.generatedMediaAdmitter === undefined && bureau.generatedMediaAdmitter !== undefined
      ? { generatedMediaAdmitter: bureau.generatedMediaAdmitter }
      : {}),
  };
}
/**
 * COR-1577 — the media options of a session run: Bureau's for the run's owner, except where the
 * named agent supplied its own resolver or unverified-asset policy, as on a catalog dispatch.
 */
export function sessionRunMediaOptions(
  sessionAgent: SessionAgentRun | undefined,
  bureau: MediaRunOptions,
): MediaRunOptions {
  if (sessionAgent === undefined) return bureau;
  const { contentSourceResolver, assetSafety, generatedMediaAdmitter } = sessionAgent.options;
  return {
    ...(contentSourceResolver === undefined ? {} : { contentSourceResolver }),
    ...(assetSafety === undefined ? {} : { assetSafety }),
    ...(generatedMediaAdmitter === undefined ? {} : { generatedMediaAdmitter }),
    ...unsetMediaOptions(sessionAgent.options, bureau),
  };
}
function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = getOwn(candidate.messages, id);
    const baseMessage = getOwn(base.messages, id);
    const message =
      candidateMessage &&
      (!baseMessage ||
        !messagesAreEqual(candidateMessage, baseMessage) ||
        !getOwn(current.messages, id))
        ? candidateMessage
        : (getOwn(current.messages, id) ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = getOwn(messages, id);
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: {
      ...current.metadata,
      ...candidate.metadata,
    },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}
