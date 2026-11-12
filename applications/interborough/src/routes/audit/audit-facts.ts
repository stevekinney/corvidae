/**
 * What the pane of one audit event shows under its title: the line that says when and where, the
 * facts of the record (a provider and its effect, an agent and its version, a tool and its risk and
 * the status of the call), and the links that open the thing the event is about. The facts are
 * data, so the pane draws them in one place and a test reads them without drawing anything.
 */
import { humanizeIdentifier } from '@lostgradient/cinder';

import { AUDIT_COPY } from '../../app/copy/audit.ts';
import { agentPath } from '../../lib/agent-paths.ts';
import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath } from '../../lib/router.svelte.ts';
import type { StatusWord } from '../../lib/status.ts';
import {
  amountOf,
  LONG_TARGET_CHARACTERS,
  reviewIdOf,
  summaryOf,
  whenOf,
  type AuditEvent,
  type AuditLookups,
} from './audit-events.ts';
import { resourcePath, splitResource } from './audit-filter.ts';

/** How a fact's value is drawn. */
export type AuditFactValue =
  | { readonly kind: 'text'; readonly text: string; readonly muted?: boolean }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }
  | { readonly kind: 'tool'; readonly title: string; readonly identifier: string }
  | { readonly kind: 'status'; readonly word: StatusWord };

/** One row of the pane: a term and its value. */
export interface AuditFact {
  readonly term: string;
  readonly value: AuditFactValue;
}

/** A link under the facts that opens what the event is about. */
export interface AuditLink {
  readonly label: string;
  readonly href: string;
}

/** What the pane shows of one event, before any diff of an agent's instructions. */
export interface AuditDetailModel {
  /** "Today at 10:45:12 AM, from this browser". */
  readonly whenLine: string;
  readonly facts: readonly AuditFact[];
  readonly links: readonly AuditLink[];
}

function text(event: AuditEvent, name: string): string | undefined {
  const value = event.record.detail?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function textFact(term: string, value: string, muted = false): AuditFact {
  return { term, value: { kind: 'text', text: value, ...(muted ? { muted } : {}) } };
}

/** The words of what changed in an agent's version: "Instructions, Tools, added Issue refund". */
export function changedWords(
  changedKeys: string | undefined,
  toolsAdded: string | undefined,
  toolsRemoved: string | undefined,
  toolName: (identifier: string) => string,
): string {
  const words = new Map<string, string>(Object.entries(AUDIT_COPY.changedWords));
  const parts = (changedKeys ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '')
    .map((key) => {
      return words.get(key) ?? humanizeIdentifier(key, { casing: 'sentence' });
    });
  const names = (list: string): string =>
    list
      .split(',')
      .map((name) => toolName(name.trim()))
      .join(', ');
  if (toolsAdded !== undefined) parts.push(AUDIT_COPY.toolsAdded(names(toolsAdded)));
  if (toolsRemoved !== undefined) parts.push(AUDIT_COPY.toolsRemoved(names(toolsRemoved)));
  return parts.join(', ');
}

/**
 * How risky the call was, in words: the tool's tier when the catalog names the tool, else the risk
 * its review carries (the catalog does not list a tool an agent keeps to itself).
 */
function riskText(
  tier: 'read-only' | 'mutating' | 'dangerous' | null | undefined,
  review: BureauToolApproval | null | undefined,
): string | null {
  const risk =
    review?.approval.action.type === 'approval' ? review.approval.action.risk : undefined;
  const level =
    tier === 'dangerous' || tier === 'mutating'
      ? tier
      : risk === 'high'
        ? 'dangerous'
        : risk === 'medium'
          ? 'mutating'
          : null;
  if (level === 'dangerous') return AUDIT_COPY.riskDangerous;
  if (level === 'mutating') return AUDIT_COPY.riskChanges;
  return null;
}

/** The status of a tool call that asked first, from the review it waits in. */
function callStatus(event: AuditEvent, lookups: AuditLookups): StatusWord {
  if (event.record.type === 'tool.settled' && text(event, 'status') !== 'paused') {
    return text(event, 'status') === 'success' ? 'Done' : 'Failed';
  }
  const review = lookups.reviews.get(reviewIdOf(event.record) ?? '');
  if (review === undefined || review === null) {
    return event.record.type === 'review.tool-approval.approved' ? 'Done' : 'Waiting on you';
  }
  return review.status === 'pending'
    ? 'Waiting on you'
    : review.status === 'approved'
      ? 'Done'
      : 'Canceled';
}

/** The pane's facts and links for an event. */
export function detailOf(event: AuditEvent, lookups: AuditLookups, now: number): AuditDetailModel {
  const { record } = event;
  // A tool's records name no chat; the review a call waits in does.
  const review = lookups.reviews.get(reviewIdOf(record) ?? '');
  const sessionId = text(event, 'sessionId') ?? review?.sessionId;
  const chatTitle = sessionId === undefined ? undefined : lookups.chatTitles.get(sessionId);
  const context =
    event.actor.kind === 'you'
      ? AUDIT_COPY.fromThisBrowser
      : chatTitle !== undefined && chatTitle !== null && event.actor.kind === 'agent'
        ? AUDIT_COPY.inTheChat(chatTitle)
        : null;
  const whenLine = AUDIT_COPY.whenLine(whenOf(event.at, now), context);
  const agent = text(event, 'agentName');
  const facts: AuditFact[] = [];
  const links: AuditLink[] = [];

  switch (record.type) {
    case 'provider.disconnected': {
      const provider = event.target.replace(/ provider$/, '');
      facts.push(textFact(AUDIT_COPY.fact.provider, provider));
      facts.push(textFact(AUDIT_COPY.fact.effect, AUDIT_COPY.providerRemovedEffect));
      links.push({ label: AUDIT_COPY.links.providers, href: '/settings/models' });
      break;
    }
    case 'agent.updated': {
      const revision = record.detail?.['revision'];
      const previous = record.detail?.['previousRevision'];
      const id = splitResource(record.resource).id;
      facts.push({
        term: AUDIT_COPY.fact.agent,
        value: { kind: 'link', text: lookups.agentName(id), href: agentPath(id) },
      });
      if (typeof revision === 'number') {
        facts.push(
          textFact(
            AUDIT_COPY.fact.version,
            typeof previous === 'number' ? `${previous} → ${revision}` : String(revision),
          ),
        );
      }
      const changed = changedWords(
        text(event, 'changedKeys'),
        text(event, 'toolsAdded'),
        text(event, 'toolsRemoved'),
        (name) =>
          lookups.tools.get(name)?.title ?? humanizeIdentifier(name, { casing: 'sentence' }),
      );
      if (changed !== '') facts.push(textFact(AUDIT_COPY.fact.changed, changed));
      break;
    }
    case 'tool.settled':
    case 'review.tool-approval.approved':
    case 'review.tool-approval.denied': {
      const name = text(event, 'toolName') ?? '';
      const tool = lookups.tools.get(name);
      facts.push({
        term: AUDIT_COPY.fact.tool,
        value: {
          kind: 'tool',
          title: tool?.title ?? humanizeIdentifier(name, { casing: 'sentence' }),
          identifier: name,
        },
      });
      const risk = riskText(tool?.tier, review);
      if (risk !== null) facts.push(textFact(AUDIT_COPY.fact.risk, risk, true));
      const amount = amountOf(summaryOf(review));
      if (amount !== undefined) facts.push(textFact(AUDIT_COPY.fact.amount, amount));
      facts.push({
        term: AUDIT_COPY.fact.status,
        value: { kind: 'status', word: callStatus(event, lookups) },
      });
      const reviewId = reviewIdOf(record);
      if (reviewId !== undefined) {
        links.push({
          label: AUDIT_COPY.links.review,
          href: `/reviews?review=${encodeURIComponent(reviewId)}`,
        });
      }
      break;
    }
    case 'run.started':
    case 'run.aborted':
    case 'run.error': {
      if (agent !== undefined) {
        facts.push({
          term: AUDIT_COPY.fact.agent,
          value: { kind: 'link', text: lookups.agentName(agent), href: agentPath(agent) },
        });
      }
      if (sessionId !== undefined && chatTitle !== undefined && chatTitle !== null) {
        facts.push({
          term: AUDIT_COPY.fact.chat,
          value: { kind: 'link', text: chatTitle, href: chatSessionPath(sessionId) },
        });
      }
      const href = resourcePath(record.resource);
      if (href !== undefined) links.push({ label: AUDIT_COPY.links.run, href });
      break;
    }
    case 'schedule.missed':
    case 'schedule.fired':
    case 'schedule.created':
    case 'schedule.paused':
    case 'schedule.resumed':
    case 'schedule.cancelled': {
      const id = text(event, 'scheduleId') ?? splitResource(record.resource).id;
      facts.push({
        term: AUDIT_COPY.fact.schedule,
        value: { kind: 'link', text: event.target, href: scheduleDetailPath(id) },
      });
      break;
    }
    case 'memory.corrected':
    case 'memory.forgotten': {
      if (agent !== undefined) {
        facts.push({
          term: AUDIT_COPY.fact.agent,
          value: { kind: 'link', text: lookups.agentName(agent), href: agentPath(agent) },
        });
      }
      break;
    }
    default: {
      const href = resourcePath(record.resource);
      // A target too long for a row is shown whole under its own heading, and is no fact.
      if (
        event.target !== '' &&
        event.target.length <= LONG_TARGET_CHARACTERS &&
        record.type !== 'host.started'
      ) {
        facts.push(
          href === undefined
            ? textFact(AUDIT_COPY.fact.about, event.target)
            : {
                term: AUDIT_COPY.fact.about,
                value: { kind: 'link', text: event.target, href },
              },
        );
      }
    }
  }
  return { whenLine, facts, links };
}
