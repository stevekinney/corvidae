/**
 * The browser's calls to the Bureau's chat and session operations, through the one generated client
 * (`./bureau-api.ts`), which sends them to the host's composed `/jsonrpc` (`src/host/host.ts`).
 * Weft's `HttpClient` speaks only the engine's operations, so the Bureau's are called here, with
 * the same fault vocabulary: a fault answers as an `HttpClientError`, which `classifyFault`
 * (`./faults.ts`) already treats.
 *
 * There is no sign-in. The host serves every request as the one local caller.
 */
import { HttpClientError } from '@lostgradient/weft/client';
import { z } from 'zod';

import { bureauClient, type BureauInput, type BureauOutput } from './bureau-api.ts';
import type { CatalogOperations } from './generated/bureau-operation-client.generated.ts';

/** The part of `fetch` the application's requests use, so a test can stand a stub in for it. */
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Where the host mounts the Bureau handler. */
export const BUREAU_PATH = '/bureau';

/** The origins the Bureau can be asked to filter sessions by. */
export type ContextOrigin = 'chat' | 'goal' | 'schedule';

/**
 * Every origin a session can report: those a list can be filtered by in the chat views, and `try`,
 * a throwaway chat with an unsaved agent definition (`bureau.agents.try`), which the Bureau leaves
 * out of the list unless it is asked for.
 */
export type ReportedOrigin = ContextOrigin | 'try';

type ListedContext = BureauOutput<'bureau.contexts.list'>['contexts'][number];

/** What a session reads as when the Bureau names an origin this client does not know. */
type OriginReading = ReportedOrigin | 'other';

/**
 * A session (a Bureau context), as `bureau.contexts.get` and `.list` show it, once
 * {@link chatContextOf} has read it. `origin` is what started the session: a person's `chat`, a
 * `goal`, a `schedule`'s fire, or `try`; a session that records none is a chat, and a value this
 * client does not know (a Bureau newer than the browser) reads `other`: the session is kept, and
 * since only a `chat` is shown in Chat, it is not one. `endReason` is why the chat's last run ended
 * when the host stopped it (`host-stopped`, a run that a restart aborted, which can no longer
 * continue, COR-2009): `null` for a chat whose run ended on its own or ran again since, absent from
 * a Bureau that does not say; a reason this client does not know reads `other`. `archivedAt` is when
 * the session was archived (`bureau.contexts.archive`), as an ISO 8601 timestamp, or `null` when it
 * is not; an archived session takes no new message, steering or regenerated answer until it is
 * unarchived. It is absent from a Bureau that does not say, which reads as not archived.
 */
export type ChatContext = Omit<ListedContext, 'origin' | 'endReason' | 'archivedAt'> & {
  readonly origin: OriginReading;
  readonly endReason?: 'host-stopped' | 'other' | null | undefined;
  readonly archivedAt?: string | null | undefined;
};

/** A session as a Bureau of any release can answer it: an origin or an end reason may be one this client does not know. */
type WireContext = Omit<ListedContext, 'origin' | 'endReason' | 'archivedAt'> & {
  readonly origin?: unknown;
  readonly endReason?: unknown;
  readonly archivedAt?: string | null | undefined;
};

function originOf(origin: unknown): OriginReading {
  if (origin === undefined) return 'chat';
  if (origin === 'chat' || origin === 'goal' || origin === 'schedule' || origin === 'try') {
    return origin;
  }
  return 'other';
}

/**
 * Reads what the server's schema leaves open in a session: a session that names no origin is a
 * chat, an origin this client does not know reads `other`, and an end reason it does not know reads
 * `other`.
 */
export function chatContextOf(context: WireContext): ChatContext {
  const { origin, endReason, ...rest } = context;
  return {
    ...rest,
    origin: originOf(origin),
    ...(endReason === undefined
      ? {}
      : { endReason: endReason === null || endReason === 'host-stopped' ? endReason : 'other' }),
  };
}

/** The reasoning efforts a session can be set to (`bureau.contexts.steer`'s `effort`). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * How readily a session's tool calls ask a person, as `bureau.contexts.steer` takes it and
 * `bureau.contexts.get` reports it: `on-changes` asks as each tool's own setting says (the default),
 * `always` asks on every call, `allow-all` skips the asks `on-changes` would raise, and `read-only`
 * denies every tool that is not read-only. It governs every tool of the chat's runs, whichever
 * kind of agent holds it; only `requestHumanInput`, which just asks a person, stands outside it.
 */
export type PermissionMode = 'always' | 'on-changes' | 'allow-all' | 'read-only';

type DetailedContext = BureauOutput<'bureau.contexts.get'>;

/**
 * One session as `bureau.contexts.get` shows it: the summary, and what its steering has settled on.
 * `model` is the latest model the session was switched to, `null` before any, which means the
 * agent's default; `effort` is the latest effort it was set to, `null` before any; `permissionMode`
 * is its permission mode, `on-changes` before one was set; `configVersion` is
 * the version a later `bureau.contexts.steer`'s `expectedRevision` is compared against.
 */
export type ContextDetail = ChatContext &
  Pick<DetailedContext, 'model' | 'effort' | 'permissionMode' | 'configVersion'>;

/** What `bureau.contexts.input` answers for an input it admitted: whether it was admitted or replayed, and the receipt's identifier and state. */
export type ContextInputReceipt = BureauOutput<'bureau.contexts.input'>;

/** The committed replacement returned by `bureau.contexts.regenerate`. */
export type ContextRegenerateReceipt = BureauOutput<'bureau.contexts.regenerate'>;

/**
 * The Bureau's own identifier (`bureau.deployment.get`), which `bureau.events` names as its
 * `bureauId`. The feed is addressed by it and answers `NotFound` for any other.
 */
export async function getBureauId(options?: { readonly signal?: AbortSignal }): Promise<string> {
  const answer = await bureauClient['bureau.deployment.get']({}, options);
  return answer.id;
}

/** One session, with its agent, title and model. A session the caller cannot see is a not-found fault. */
export async function getContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
  client: Pick<CatalogOperations, 'bureau.contexts.get'> = bureauClient,
): Promise<ContextDetail> {
  const detail = await client['bureau.contexts.get']({ contextId }, options);
  return {
    ...chatContextOf(detail),
    model: detail.model,
    effort: detail.effort,
    permissionMode: detail.permissionMode,
    configVersion: detail.configVersion,
  };
}

/** What fills a context's window, as `bureau.contexts.window` names the categories, in its order. */
export const WINDOW_CATEGORIES = ['system', 'tools', 'messages', 'memory', 'attachments'] as const;

/** One thing that fills a context's window. */
export type WindowCategoryName = (typeof WINDOW_CATEGORIES)[number];

/**
 * How full a context's window is (`bureau.contexts.window`): `maxTokens` is the window of the model
 * that would answer, `null` when it is not known; `usedEstimated` is the estimated size of the next
 * prompt and always the sum of `categories`; `usedReported` is the provider's own count for the
 * latest step, `null` when there is none. It holds counts only.
 */
export type ContextWindow = BureauOutput<'bureau.contexts.window'>;

/** How full one session's window is, and what fills it (`bureau.contexts.window`). */
export async function getContextWindow(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextWindow> {
  return bureauClient['bureau.contexts.window']({ contextId }, options);
}

/**
 * One model an agent allows a session to be switched to: its provider, model name, and display
 * name; `unpriced` when the agent's cost budget cannot count the model, `denied` when the model
 * policy forbids it.
 */
export type AgentModelChoice = BureauOutput<'bureau.agents.models'>['models'][number];

/**
 * The models a session of an agent may be switched to, whether the agent allows a choice at all,
 * and the model used with no override (`null` when that is not known).
 */
export type AgentModels = BureauOutput<'bureau.agents.models'>;

/** The models a session of an agent may be switched to (`bureau.agents.models`). */
export async function getAgentModels(
  agentName: string,
  options?: { readonly signal?: AbortSignal },
): Promise<AgentModels> {
  return bureauClient['bureau.agents.models']({ agentName }, options);
}

/**
 * How the Bureau answered a request to switch a session's model: accepted, replayed, conflicting,
 * rejected with a reason, or refused because the session ended or cannot be steered. A refusal is
 * an outcome and not a fault; only a missing session or a malformed request is a fault. The reasons
 * are read as the Bureau names them (`model-not-allowed`, `stale-revision`, and so on).
 */
export type SteerOutcome = BureauOutput<'bureau.contexts.steer'>;

/**
 * Changes one setting of a session (`bureau.contexts.steer`): `override` switches it to another
 * model its agent allows, `effort` sets its reasoning effort, `permissionMode` sets how readily its
 * tool calls ask a person, and a request carries exactly one.
 * `commandId` is the caller's own identifier: an exact retry of it is a replay. `expectedRevision`
 * is the `configVersion` the caller read.
 */
export async function steerContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly expectedRevision?: number;
  } & (
    | {
        readonly override: { readonly provider: string; readonly model: string };
        readonly effort?: never;
        readonly permissionMode?: never;
      }
    | {
        readonly effort: Effort;
        readonly override?: never;
        readonly permissionMode?: never;
      }
    | {
        readonly permissionMode: PermissionMode;
        readonly override?: never;
        readonly effort?: never;
      }
  ),
  options?: { readonly signal?: AbortSignal },
): Promise<SteerOutcome> {
  return bureauClient['bureau.contexts.steer'](input, options);
}

/**
 * Branches a session after one of its agent's replies, or before its first message when
 * `throughMessageId` is `null` (`bureau.contexts.fork`), and returns the new session's identifier. A refusal is a `Conflict` fault whose `data.reason` says why
 * (`forkRefusalReason`).
 */
export async function forkContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly throughMessageId: string | null;
  },
  options?: { readonly signal?: AbortSignal },
): Promise<string> {
  const answer = await bureauClient['bureau.contexts.fork'](input, options);
  return answer.contextId;
}

/** Why a branch was refused: the `data.reason` of the fault, or `undefined` for any other fault. */
export function forkRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError)) return undefined;
  const reason = error.data?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Why `bureau.contexts.steer` refused a request with an `InvalidParams` fault, in the Bureau's own
 * words (the message of the first issue it names, such as an agent whose cost budget cannot count
 * the model), or `undefined` for any other fault or a failure that was not a fault.
 */
export function steerRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError) || error.data?.['weftCode'] !== 'InvalidParams') {
    return undefined;
  }
  const issues = error.data['issues'];
  if (!Array.isArray(issues)) return undefined;
  const first: unknown = issues[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/** Sends an input to a session's run in flight (`bureau.contexts.input`, steer delivery). */
export async function sendContextInput(
  contextId: string,
  input: BureauInput<'bureau.contexts.input'>['input'],
  options?: { readonly signal?: AbortSignal },
): Promise<ContextInputReceipt> {
  return bureauClient['bureau.contexts.input']({ contextId, input }, options);
}

/** Replaces the final ended assistant answer without starting a new turn or running tools. */
export async function regenerateContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly messageId: string;
  },
  options?: { readonly signal?: AbortSignal; readonly fetch?: Fetcher },
): Promise<ContextRegenerateReceipt> {
  return bureauClient['bureau.contexts.regenerate'](input, options);
}

/**
 * Takes back a follow-up the run has not taken yet (`bureau.contexts.retract`), by the id it was
 * sent under: the Remove on a queued message. `retracted` means it will never be delivered, and
 * `delivered` that the run already took it, so it stands as a sent message. An input the Bureau no
 * longer holds (a `NotFound`) will never be delivered either, so it answers `retracted`; any other
 * failure throws, and the follow-up stays queued.
 */
export async function retractContextInput(
  contextId: string,
  inputId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<'retracted' | 'delivered'> {
  try {
    const answer = await bureauClient['bureau.contexts.retract']({ contextId, inputId }, options);
    return answer.outcome;
  } catch (error) {
    if (wireCodeOf(error) === 'NotFound') return 'retracted';
    throw error;
  }
}

/**
 * Forgets a session's "Allow for the rest of this chat" grant of each tool in `tools` (tool names,
 * `bureau.contexts.forgetgrants`), so the next call of that tool asks for approval again. It removes
 * no row: Retry keeps the failed attempt on record and sends a new turn after it. Resolves the
 * grants forgotten, as the Bureau stored them; a missing session is a `NotFound` fault, and any
 * failure throws.
 */
export async function forgetContextGrants(
  input: { readonly contextId: string; readonly tools: readonly string[] },
  options?: { readonly signal?: AbortSignal },
): Promise<readonly string[]> {
  const answer = await bureauClient['bureau.contexts.forgetgrants'](input, options);
  return answer.forgotten;
}

/**
 * Gives a session a title of the caller's choosing (`bureau.contexts.rename`), or takes the one it
 * was given away with `null`, which shows the title derived from its first message again. The
 * Bureau trims the title and refuses a blank one or one over 200 characters as `InvalidParams`.
 * Setting the title a session already has is not an error, so a retry is safe. The answer is a
 * receipt: the title now stored (`null` once removed), not the session.
 */
export async function renameContext(
  input: { readonly contextId: string; readonly title: string | null },
  options?: { readonly signal?: AbortSignal },
): Promise<string | null> {
  const answer = await bureauClient['bureau.contexts.rename'](input, options);
  return answer.title;
}

/**
 * What archiving or unarchiving a session settled: whether this call changed it, and when it was
 * archived (`null` once it is not).
 */
export type ContextArchiveReceipt = BureauOutput<'bureau.contexts.archive'>;

/**
 * Archives a session (`bureau.contexts.archive`), so it takes no new message, steering or
 * regenerated answer until it is unarchived: each is then a `Conflict` fault with reason
 * `context-archived`. A session with a run going, or one waiting on an approval or an answer, is
 * a `Conflict` with reason `context-busy`, and nothing is archived: stop or answer it first.
 * Archiving an archived session is not an error (`changed: false`, with the time it was first
 * archived), so a retry is safe; a missing session is a `NotFound` fault.
 */
export async function archiveContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextArchiveReceipt> {
  return bureauClient['bureau.contexts.archive']({ contextId }, options);
}

/**
 * Unarchives a session (`bureau.contexts.unarchive`), so it takes work again. Unarchiving one that
 * is not archived is not an error (`changed: false`); a missing session is a `NotFound` fault.
 */
export async function unarchiveContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextArchiveReceipt> {
  return bureauClient['bureau.contexts.unarchive']({ contextId }, options);
}

/** The committed removal returned by `bureau.contexts.discardturn`. */
export type ContextDiscardTurnReceipt = BureauOutput<'bureau.contexts.discardturn'>;

/**
 * Removes the last stopped turn's generated rows while keeping the person's message. An exact
 * retry with the same command id returns the original receipt and removes nothing more.
 */
export async function discardContextTurn(
  input: BureauInput<'bureau.contexts.discardturn'>,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextDiscardTurnReceipt> {
  return bureauClient['bureau.contexts.discardturn'](input, options);
}

/** The continuation run returned by `bureau.contexts.resumeturn`. */
export type ContextResumeTurnReceipt = BureauOutput<'bureau.contexts.resumeturn'>;

/**
 * Continues a stopped turn without a new person-authored message. An exact retry with the same
 * command id returns the continuation run the Bureau already started.
 */
export async function resumeContextTurn(
  input: BureauInput<'bureau.contexts.resumeturn'>,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextResumeTurnReceipt> {
  return bureauClient['bureau.contexts.resumeturn'](input, options);
}

/**
 * What `bureau.contexts.delete` settled for the runs the session had going: `applied` (none),
 * `cleaned-up`, or a cleanup still going or unfinished, and `rejected` when the Bureau was shutting
 * down and deleted nothing.
 */
export type ContextDeleteReceipt = BureauOutput<'bureau.contexts.delete'>['receipt'];

/**
 * Deletes a session and its content, cancelling the runs it has going (`bureau.contexts.delete`).
 * A session that is already gone is a not-found fault. The receipt says whether the runs it
 * cancelled were cleaned up; `rejected` means a Bureau that was shutting down applied nothing.
 */
export async function deleteContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal; readonly fetch?: Fetcher },
): Promise<ContextDeleteReceipt> {
  const answer = await bureauClient['bureau.contexts.delete']({ contextId }, options);
  return answer.receipt;
}

/** One page of sessions and the offset of the next page, or `null` on the last. */
export type ContextPage = {
  /** The contexts returned on this page. */
  readonly contexts: readonly ChatContext[];
  /** The offset of the next page, when there is one. */
  readonly nextOffset: number | null;
};

/**
 * One page of the caller's sessions, newest update first (`bureau.contexts.list`). `origin` keeps
 * only the sessions that were started that way, before the page is cut, so `chat` lists the
 * sessions a person started and none a goal or a schedule's fire did.
 */
export async function listContexts(
  input: {
    readonly agentName?: string;
    readonly origin?: ReportedOrigin;
    /** Only the chats whose title contains this text, ignoring case, before the page is cut. */
    readonly titleContains?: string;
    /** Only the chats in this activity state right now, before the page is cut. */
    readonly activity?: 'running' | 'awaiting-input';
    /**
     * Which sessions to list by whether they are archived, before the page is cut: `include` (the
     * Bureau's default) lists every one, `exclude` leaves the archived ones out, `only` lists only
     * them.
     */
    readonly archived?: 'include' | 'exclude' | 'only';
    readonly sortBy?: 'updatedAt' | 'createdAt';
    readonly sortOrder?: 'asc' | 'desc';
    readonly limit?: number;
    readonly offset?: number;
  } = {},
  options?: { readonly signal?: AbortSignal },
): Promise<ContextPage> {
  const page = await bureauClient['bureau.contexts.list'](input, options);
  return { contexts: page.contexts.map(chatContextOf), nextOffset: page.nextOffset };
}

/** How many sessions one request of {@link listAllContexts} asks for. */
const CONTEXTS_PAGE_SIZE = 100;

/**
 * Every session the caller owns: pages are read, `nextOffset` followed, until the Bureau has no
 * more. An offset that does not move forward ends the read, so a Bureau that repeats itself cannot
 * loop it. `origin` is passed to the Bureau on every page, so it filters before a page is cut.
 */
export async function listAllContexts(options?: {
  readonly signal?: AbortSignal;
  readonly origin?: ContextOrigin;
}): Promise<ChatContext[]> {
  const contexts: ChatContext[] = [];
  const { origin, ...requestOptions } = options ?? {};
  let offset = 0;
  for (;;) {
    const page = await listContexts(
      { limit: CONTEXTS_PAGE_SIZE, offset, ...(origin === undefined ? {} : { origin }) },
      requestOptions,
    );
    contexts.push(...page.contexts);
    if (page.nextOffset === null || page.nextOffset <= offset) return contexts;
    offset = page.nextOffset;
  }
}

/**
 * What an agent's model takes in the way of media (`bureau.agents.list`'s `media`). The server's
 * schema leaves the modalities untyped, so this reads their shape.
 */
export const agentMediaSchema = z.object({
  modalities: z.record(z.string(), z.object({ input: z.boolean(), output: z.boolean() })),
  mimeFamilies: z.array(z.string()),
  mediaLimits: z.array(
    z.object({ modality: z.string(), maxBytes: z.number().int().nonnegative() }),
  ),
});

/** What an agent's model takes in the way of media: its modalities, MIME families, and size limits. */
export type AgentMedia = z.infer<typeof agentMediaSchema>;

type ListedAgent = BureauOutput<'bureau.agents.list'>['agents'][number];

/**
 * An agent as the agent list shows it: its name, description, kind, A2A opt-in, attachment support
 * (`media`, `null` for an agent that names no model, which can take no attachment), tools (absent
 * when the Bureau does not say, which is not the same as `[]`, an agent it says has none), example
 * prompts a new chat offers as buttons, and `visibility`: `hidden` for an agent a plugin keeps out
 * of Chat's agent list (COR-2233), absent for an agent a chat can start with.
 */
export type AgentSummary = Omit<ListedAgent, 'media'> & { readonly media: AgentMedia | null };

/**
 * An agent as a Bureau of any release lists it: one that does not say `media` reads as taking none,
 * and the media it does say are read by shape.
 */
export function agentSummaryOf(
  agent: Omit<ListedAgent, 'media'> & { readonly media?: unknown },
): AgentSummary {
  const { media, ...rest } = agent;
  return {
    ...rest,
    media: media === undefined || media === null ? null : agentMediaSchema.parse(media),
  };
}

/** The agents the Bureau lists, each of which can take a chat (`bureau.agents.list`). */
export async function listAgents(
  options?: { readonly signal?: AbortSignal },
  client: Pick<CatalogOperations, 'bureau.agents.list'> = bureauClient,
): Promise<readonly AgentSummary[]> {
  const body = await client['bureau.agents.list']({}, options);
  return body.agents.map(agentSummaryOf);
}

const threadMessagesSchema = z.object({ threadId: z.string(), messages: z.array(z.unknown()) });

/** A thread's conversation as AG-UI messages (`GET /bureau/ag-ui/threads/<id>/messages`), or a not-found fault. */
export async function getThreadMessages(
  threadId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly fetch?: Fetcher;
    readonly shared?: boolean;
  } = {},
): Promise<readonly unknown[]> {
  const send = options.fetch ?? fetch;
  const messages = options.shared === true ? 'shared-messages' : 'messages';
  const response = await send(
    `${BUREAU_PATH}/ag-ui/threads/${encodeURIComponent(threadId)}/${messages}`,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (!response.ok) {
    throw new HttpClientError(response.status, `The thread answered ${response.status}.`);
  }
  return threadMessagesSchema.parse(await response.json()).messages;
}

/** The caller's deliberately metadata-free state for one shared-chat direct link. */
export async function getContextShareStatus(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<BureauOutput<'bureau.contexts.share.status'>> {
  return bureauClient['bureau.contexts.share.status']({ contextId }, options);
}

/** Grants one same-workspace member read-only access to a chat the caller owns. */
export async function shareContext(input: {
  readonly contextId: string;
  readonly granteeOwnerId: string;
}): Promise<BureauOutput<'bureau.contexts.share'>> {
  return bureauClient['bureau.contexts.share'](input);
}

/** Removes one member's active read grant from a chat the caller owns. */
export async function revokeContextShare(input: {
  readonly contextId: string;
  readonly granteeOwnerId: string;
}): Promise<BureauOutput<'bureau.contexts.share.revoke'>> {
  return bureauClient['bureau.contexts.share.revoke'](input);
}

/** Requests restoration of this caller's former read grant. */
export async function requestContextShare(
  contextId: string,
): Promise<BureauOutput<'bureau.contexts.share.request'>> {
  return bureauClient['bureau.contexts.share.request']({ contextId });
}

/**
 * The wire fault code a Bureau answer carried (`NotFound`, `Unprocessable`, and so on), or
 * `undefined` for an error that did not come from the Bureau. The status says only what kind of fault
 * it was; the code says which.
 */
export function wireCodeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError)) return undefined;
  const code = error.data?.['weftCode'];
  return typeof code === 'string' ? code : undefined;
}
