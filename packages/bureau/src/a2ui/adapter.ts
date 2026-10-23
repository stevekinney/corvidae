/**
 * Bureau's A2UI adapter (COR-837): it takes a batch of A2UI v0.9.1 server-to-client messages from
 * an author or a model, validates the batch as untrusted content, and commits the result to
 * COR-1631's interactive-surface store as ONE command. There is no second lifecycle store: a
 * surface is an `a2ui` surface in the task's history, and the store's revisions, receipts,
 * ownership, retention, and freezing apply to it unchanged.
 *
 * | A2UI message | Store command |
 * | --- | --- |
 * | `createSurface` (+ following `updateComponents`/`updateDataModel`) | `surface.create` |
 * | `updateComponents`, `updateDataModel` | `surface.update` (the fold of the batch) |
 * | `deleteSurface` | `surface.close` |
 *
 * A batch commits whole or not at all: every message is checked against the catalog the surface
 * uses, the folded result is checked as a graph, and only then is the single command sent.
 *
 * @experimental A2UI support is pinned to v0.9.1 and may change until a stable A2UI 1.0 review.
 * @module adapter
 */

import type { ErrorObject } from 'ajv';

import type { InteractiveSurfaces } from '../interactive-surface/store.ts';
import {
  INTERACTIVE_SURFACE_A2UI_VERSION,
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  type InteractiveSurface,
  type InteractiveSurfaceAcceptance,
  type InteractiveSurfaceActionDefinition,
  type InteractiveSurfaceAuthorization,
  type InteractiveSurfaceClassification,
  type InteractiveSurfaceContractVersion,
  type InteractiveSurfaceJsonObject,
  type InteractiveSurfaceJsonValue,
  type InteractiveSurfaceRejectionReason,
} from '../interactive-surface/types.ts';
import { a2uiCatalogOf, offeredCatalogIds, type A2uiCatalog } from './catalogs.ts';
import { checkBindings, checkEvents, checkGraph, type A2uiIssue } from './graph.ts';
import {
  A2UI_MAX_BATCH,
  A2UI_MESSAGE_DEFINITIONS,
  changeDataModel,
  classifyMessage,
  isClassified,
  mergeComponents,
  type A2uiComponent,
  type ClassifiedMessage,
} from './messages.ts';

const MAX_ISSUES = 25;
const MAX_SUMMARY = 500;

/** A batch of A2UI messages for one task, and the context the adapter holds it to. @experimental */
export interface A2uiApplyRequest {
  readonly taskId: string;
  /** The caller's idempotency key for the one store command the batch becomes. */
  readonly commandId: string;
  /** The messages, untrusted: all for one surface, in order. */
  readonly messages: unknown;
  /** What a client that cannot render the surface shows. Derived from the surface's text when omitted on create. */
  readonly summary?: string | undefined;
  /**
   * The actions the surface offers, each with the continuation Bureau will run when one is
   * admitted. A component can raise only an event named here. On an update, omitted keeps them.
   */
  readonly actions?: readonly InteractiveSurfaceActionDefinition[] | undefined;
  readonly audience?: readonly string[] | undefined;
  readonly classification?: InteractiveSurfaceClassification | undefined;
  /**
   * The catalogs the audience's client declared (`supportedCatalogIds`). Omitted, only the basic
   * catalog may be used.
   */
  readonly supportedCatalogIds?: readonly string[] | undefined;
  /** The surface revision the batch builds on; the commit fails if the surface has moved on. Defaults to the current one. */
  readonly baseRevision?: number | undefined;
  /** Require a whole surface: a `root`, no dangling reference, nothing unreachable. */
  readonly complete?: boolean | undefined;
}

/** A refusal, with the specific reasons. Nothing was committed. @experimental */
export interface A2uiRejection {
  readonly contractVersion: InteractiveSurfaceContractVersion;
  readonly outcome: 'rejected';
  readonly reason: InteractiveSurfaceRejectionReason;
  readonly detail: string;
  /** Structured feedback an author or model can repair the proposal from. */
  readonly issues: readonly A2uiIssue[];
  readonly currentRevision?: number | undefined;
}

/** A committed batch. @experimental */
export interface A2uiAcceptance {
  readonly outcome: 'accepted';
  /** The store's receipt for the command. */
  readonly receipt: InteractiveSurfaceAcceptance;
  /** Whether the surface still lacks a `root`. */
  readonly rootMissing: boolean;
  /** Component ids referenced but not yet defined. */
  readonly dangling: readonly string[];
}

/** What {@link A2uiAdapter.apply} returns. @experimental */
export type A2uiApplyReceipt = A2uiAcceptance | A2uiRejection;

/** Bureau's A2UI adapter. @experimental */
export interface A2uiAdapter {
  /** Validates and commits a batch of A2UI messages. Never throws for a refused proposal. */
  apply(
    request: A2uiApplyRequest,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<A2uiApplyReceipt>;
}

function reject(
  reason: InteractiveSurfaceRejectionReason,
  detail: string,
  issues: readonly A2uiIssue[] = [],
  currentRevision?: number,
): A2uiRejection {
  return {
    contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
    outcome: 'rejected',
    reason,
    detail,
    issues: issues.slice(0, MAX_ISSUES),
    ...(currentRevision === undefined ? {} : { currentRevision }),
  };
}

function issuesOf(errors: readonly ErrorObject[] | null | undefined, base: string): A2uiIssue[] {
  return (errors ?? []).slice(0, MAX_ISSUES).map((error) => {
    const extra = error.params as Record<string, unknown>;
    const named =
      extra['additionalProperty'] ?? extra['unevaluatedProperty'] ?? extra['missingProperty'];
    return {
      path: `${base}${error.instancePath}`,
      message: `${error.message ?? 'is invalid'}${typeof named === 'string' ? ` (${named})` : ''}`,
    };
  });
}

/** The text of a surface's literal `Text` components, joined: what a client without A2UI is shown. */
function summaryOf(components: readonly A2uiComponent[], surfaceId: string): string {
  const texts = components
    .filter(
      (component) => component['component'] === 'Text' && typeof component['text'] === 'string',
    )
    .map((component) => (component['text'] as string).trim())
    .filter((text) => text !== '');
  const joined = texts.join('\n').slice(0, MAX_SUMMARY);
  return joined === '' ? `Interactive surface "${surfaceId}".` : joined;
}

/** Validates one message against the surface's catalog. */
function checkMessage(
  catalog: A2uiCatalog,
  classified: ClassifiedMessage,
  index: number,
): A2uiIssue[] {
  const base = `/messages/${index}`;
  const { kind, message } = classified;
  if (kind !== 'updateComponents') {
    const validate = catalog.messageValidator(A2UI_MESSAGE_DEFINITIONS[kind]);
    return validate(message) ? [] : issuesOf(validate.errors, base);
  }
  // Check each component against its own catalog definition, so an error names the component and
  // the property and not every branch of the catalog's component union.
  const issues: A2uiIssue[] = [];
  const body = message['updateComponents'] as Record<string, unknown>;
  const components = body['components'];
  if (!Array.isArray(components) || components.length === 0) {
    return [{ path: `${base}/updateComponents/components`, message: 'must be a non-empty array' }];
  }
  for (const [position, component] of components.entries()) {
    const where = `${base}/updateComponents/components/${position}`;
    if (typeof component !== 'object' || component === null || Array.isArray(component)) {
      issues.push({ path: where, message: 'A component must be a JSON object.' });
      continue;
    }
    const name = (component as Record<string, unknown>)['component'];
    const validate = typeof name === 'string' ? catalog.componentValidator(name) : undefined;
    if (validate === undefined) {
      issues.push({
        path: `${where}/component`,
        message: `"${String(name).slice(0, 80)}" is not a component of the catalog ${catalog.id}.`,
      });
    } else if (!validate(component)) {
      issues.push(...issuesOf(validate.errors, where));
    }
  }
  const envelope = catalog.messageValidator(A2UI_MESSAGE_DEFINITIONS.updateComponents);
  if (issues.length === 0 && !envelope(message)) {
    issues.push(...issuesOf(envelope.errors, base));
  }
  return issues;
}

/** Creates the adapter over a Bureau's interactive surfaces. @experimental */
export function createA2uiAdapter(options: {
  readonly surfaces: InteractiveSurfaces;
}): A2uiAdapter {
  const { surfaces } = options;

  async function apply(
    request: A2uiApplyRequest,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<A2uiApplyReceipt> {
    // Snapshot the caller-owned input before the first await.
    const { taskId, commandId, complete = false } = request;
    const batch: unknown = request.messages;
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > A2UI_MAX_BATCH) {
      return reject(
        'invalid',
        `messages must be an array of 1 to ${A2UI_MAX_BATCH} A2UI messages.`,
      );
    }
    const classified: ClassifiedMessage[] = [];
    for (const [index, message] of batch.entries()) {
      const result = classifyMessage(message, index);
      if (!isClassified(result)) return reject('invalid', result.message, [result]);
      classified.push(result);
    }
    const surfaceId = classified[0]!.surfaceId;
    if (classified.some((entry) => entry.surfaceId !== surfaceId)) {
      return reject(
        'invalid',
        'A batch addresses one surface; every message needs the same surfaceId.',
      );
    }
    const first = classified[0]!;
    const creating = first.kind === 'createSurface';
    if (classified.slice(1).some((entry) => entry.kind === 'createSurface')) {
      return reject('invalid', 'createSurface may only be the first message of a batch.');
    }
    if (classified.some((entry) => entry.kind === 'deleteSurface') && classified.length > 1) {
      return reject('invalid', 'deleteSurface must be sent alone.');
    }

    // The surface the batch builds on, for anything but a create.
    let existing: InteractiveSurface | undefined;
    if (!creating) {
      const found = await surfaces.snapshot(
        {
          type: 'surface.snapshot',
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          taskId,
          surfaceId,
        },
        authorization,
      );
      if (found.outcome === 'rejected') {
        return reject(
          found.reason,
          found.detail ?? 'The surface could not be read.',
          [],
          found.currentRevision,
        );
      }
      existing = found.surface;
      if (existing.state !== 'open' || existing.liveness !== 'live') {
        return reject(
          'closed',
          `Surface "${surfaceId}" is ${existing.liveness}.`,
          [],
          existing.revision,
        );
      }
      if (existing.kind !== 'a2ui' || existing.representation?.kind !== 'a2ui') {
        return reject('invalid', `Surface "${surfaceId}" is not an A2UI surface.`);
      }
      if (request.baseRevision !== undefined && request.baseRevision !== existing.revision) {
        return reject(
          'stale-revision',
          `The batch builds on revision ${request.baseRevision}; the surface is at ${existing.revision}.`,
          [],
          existing.revision,
        );
      }
    }
    const baseRevision = request.baseRevision ?? existing?.revision ?? 0;

    if (first.kind === 'deleteSurface') {
      const deleting = a2uiCatalogOf(
        existing!.representation!.kind === 'a2ui' ? existing!.representation!.catalogId : '',
      );
      const issues = deleting === undefined ? [] : checkMessage(deleting, first, 0);
      if (issues.length > 0)
        return reject('invalid', 'The deleteSurface message is invalid.', issues);
      const receipt = await surfaces.close(
        {
          type: 'surface.close',
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          commandId,
          taskId,
          surfaceId,
          baseRevision,
          reason: 'completed',
        },
        authorization,
      );
      if (receipt.outcome === 'rejected') {
        return reject(
          receipt.reason,
          receipt.detail ?? 'The surface could not be closed.',
          [],
          receipt.currentRevision,
        );
      }
      return { outcome: 'accepted', receipt, rootMissing: false, dangling: [] };
    }

    // The catalog: named by `createSurface` (and negotiated), or the one the surface already uses.
    let catalogId: string;
    if (creating) {
      const requested: unknown = (first.message['createSurface'] as Record<string, unknown>)[
        'catalogId'
      ];
      const offered = offeredCatalogIds(request.supportedCatalogIds);
      if (typeof requested !== 'string' || !offered.includes(requested)) {
        return reject(
          'unsupported-capability',
          `Catalog "${String(requested).slice(0, 120)}" is not offered here; offered: ${offered.join(', ') || 'none'}.`,
          [
            {
              path: '/messages/0/createSurface/catalogId',
              message: 'unknown or not negotiated catalog',
            },
          ],
        );
      }
      catalogId = requested;
    } else {
      const representation = existing!.representation!;
      catalogId = representation.kind === 'a2ui' ? representation.catalogId : '';
    }
    const catalog = a2uiCatalogOf(catalogId);
    if (catalog === undefined) {
      return reject('unsupported-capability', `Catalog "${catalogId.slice(0, 120)}" is not known.`);
    }

    const issues: A2uiIssue[] = [];
    for (const [index, entry] of classified.entries())
      issues.push(...checkMessage(catalog, entry, index));
    if (issues.length > 0)
      return reject('invalid', 'The A2UI messages are invalid; nothing was committed.', issues);

    // Fold the batch into the surface's next components and data model.
    let components: A2uiComponent[] = [
      ...(existing?.representation?.kind === 'a2ui' ? existing.representation.components : []),
    ];
    let data: InteractiveSurfaceJsonValue = existing?.data ?? null;
    let theme: InteractiveSurfaceJsonObject | undefined =
      existing?.representation?.kind === 'a2ui' ? existing.representation.theme : undefined;
    let sendDataModel: boolean | undefined =
      existing?.representation?.kind === 'a2ui' ? existing.representation.sendDataModel : undefined;
    let touchedComponents = creating;
    let touchedData = false;
    for (const [index, entry] of classified.entries()) {
      if (entry.kind === 'createSurface') {
        const body = entry.message['createSurface'] as Record<string, unknown>;
        theme = body['theme'] as InteractiveSurfaceJsonObject | undefined;
        sendDataModel = body['sendDataModel'] as boolean | undefined;
      } else if (entry.kind === 'updateComponents') {
        const incoming = (entry.message['updateComponents'] as Record<string, unknown>)[
          'components'
        ] as A2uiComponent[];
        components = mergeComponents(components, incoming);
        touchedComponents = true;
      } else if (entry.kind === 'updateDataModel') {
        const body = entry.message['updateDataModel'] as Record<string, unknown>;
        const change = changeDataModel(
          data,
          body['path'] as string | undefined,
          Object.hasOwn(body, 'value') ? (body['value'] as InteractiveSurfaceJsonValue) : undefined,
        );
        if (!change.ok) {
          return reject('invalid', 'The data model update is invalid; nothing was committed.', [
            { path: `/messages/${index}/updateDataModel`, message: change.message },
          ]);
        }
        data = change.data;
        touchedData = true;
      }
    }

    // The folded graph, its bindings, and the events it may raise.
    const report = checkGraph(components, catalog, complete);
    const declared = new Set(
      (request.actions ?? existing?.actions ?? []).map((action) => action.name),
    );
    const graphIssues = [
      ...report.issues,
      ...checkBindings(components),
      ...checkEvents(components, declared),
    ];
    if (graphIssues.length > 0) {
      return reject(
        'invalid',
        'The component graph is invalid; nothing was committed.',
        graphIssues,
        existing?.revision,
      );
    }

    const representation = {
      kind: 'a2ui',
      specificationVersion: INTERACTIVE_SURFACE_A2UI_VERSION,
      catalogId,
      components,
      ...(theme === undefined ? {} : { theme }),
      ...(sendDataModel === undefined ? {} : { sendDataModel }),
    } as const;

    const receipt = creating
      ? await surfaces.create(
          {
            type: 'surface.create',
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            commandId,
            taskId,
            surfaceId,
            summary: request.summary ?? summaryOf(components, surfaceId),
            representation,
            ...(touchedData ? { data } : {}),
            actions: request.actions ?? [],
            ...(request.audience === undefined ? {} : { audience: request.audience }),
            ...(request.classification === undefined
              ? {}
              : { classification: request.classification }),
          },
          authorization,
        )
      : await surfaces.update(
          {
            type: 'surface.update',
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            commandId,
            taskId,
            surfaceId,
            baseRevision,
            ...(touchedComponents ? { representation } : {}),
            ...(touchedData ? { data } : {}),
            ...(request.summary === undefined ? {} : { summary: request.summary }),
            ...(request.actions === undefined ? {} : { actions: request.actions }),
          },
          authorization,
        );
    if (receipt.outcome === 'rejected') {
      return reject(
        receipt.reason,
        receipt.detail ?? 'The surface could not be saved.',
        [],
        receipt.currentRevision,
      );
    }
    return { outcome: 'accepted', receipt, rootMissing: !report.rooted, dangling: report.dangling };
  }

  return { apply };
}
