/** Built-in tools for dispatching and inspecting durable child runs. */

import { createTool, type Tool, type ToolContext } from 'armorer';
import { z } from 'zod';

import type { BureauChildren } from './child-topology';
import type { AgentInput } from '@lostgradient/operative';
import type { AgentFileDetail } from './agent-file-catalog';
import type { AssetService } from './assets/types';
import { managedAssetPart } from './asset-tools';
import { AssetNotFoundError } from './assets/errors';
import type { WorkspaceOwnerAuthority } from './http/workspace-principal';

const referenceInput = z.object({ childRunId: z.string().min(1) });

export interface ChildRunToolHost {
  readonly children: () => BureauChildren | undefined;
  readonly assets: () => AssetService | undefined;
  readonly ownerOfRun: (runId: string) => Promise<string | undefined>;
  readonly agentDetail: (id: string) => Promise<AgentFileDetail | undefined>;
  readonly runAgent: (runId: string) => Promise<string | undefined>;
  readonly workspaceAuthority?: (owner: string) => WorkspaceOwnerAuthority | undefined;
}

function runIdOf(context: ToolContext | undefined): string | undefined {
  const parent = context?.executionContext?.['parentRunId'];
  if (typeof parent === 'string' && parent !== '') return parent;
  return typeof context?.runId === 'string' && context.runId !== '' ? context.runId : undefined;
}

function principalOf(context: ToolContext | undefined): string | undefined {
  const principal = context?.requestContext?.authority.principalId;
  return typeof principal === 'string' && principal !== '' ? principal : undefined;
}

async function caller(
  host: ChildRunToolHost,
  context: ToolContext | undefined,
): Promise<
  { children: BureauChildren; parentRunId: string; principal?: string | undefined } | undefined
> {
  const children = host.children();
  const parentRunId = runIdOf(context);
  if (children === undefined || parentRunId === undefined) return undefined;
  return {
    children,
    parentRunId,
    ...(principalOf(context) === undefined ? {} : { principal: principalOf(context) }),
  };
}

/** Creates the five built-in durable child-run tools. */
export function createChildRunTools(host: ChildRunToolHost): readonly Tool[] {
  const dispatch = createTool({
    name: 'child-runs-dispatch',
    version: '1.0.0',
    description: 'Dispatch one allowed agent as a durable child run.',
    metadata: {
      mutates: true,
      title: 'Dispatch child run',
      shortDescription: 'Start an allowed child run.',
    },
    input: z.object({
      agent: z.string().min(1),
      input: z.unknown(),
      assets: z.array(z.string().min(1)).optional(),
      parentCancellation: z.enum(['cascade', 'detach']).optional(),
    }),
    execute: async (input, context) => {
      const calling = await caller(host, context);
      if (calling === undefined) return { status: 'not-found' as const };
      const agent = await host.runAgent(calling.parentRunId);
      const detail = agent === undefined ? undefined : await host.agentDetail(agent);
      if (
        detail?.source !== 'file' ||
        detail.definition?.children?.includes(input.agent) !== true
      ) {
        return {
          status: 'refused' as const,
          reason: `The calling agent is not allowed to dispatch "${input.agent}".`,
        };
      }
      let childInput = input.input as AgentInput;
      if (input.assets !== undefined && input.assets.length > 0) {
        const service = host.assets();
        if (service === undefined) return { status: 'not-found' as const };
        const owner = await host.ownerOfRun(calling.parentRunId);
        if (owner === undefined) return { status: 'not-found' as const };
        const workspaceAuthority = host.workspaceAuthority?.(owner);
        const parts = [];
        for (const assetId of input.assets) {
          let descriptor;
          try {
            const resolved = await service.resolve(
              { assetId },
              {
                // The tool-execution principal may be synthesized per run; the persisted owner is
                // the authorization identity for managed assets.
                id: owner,
                ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
              },
            );
            descriptor = resolved.descriptor;
          } catch (error) {
            if (error instanceof AssetNotFoundError)
              return { status: 'refused' as const, reason: 'An asset reference is unavailable.' };
            throw error;
          }
          parts.push(managedAssetPart(descriptor));
        }
        if (typeof childInput === 'string') {
          childInput = [{ type: 'text', text: childInput }, ...parts];
        } else if (Array.isArray(childInput)) {
          childInput = [...childInput, ...parts];
        } else {
          return {
            status: 'refused' as const,
            reason: 'assets cannot be added to a conversation input.',
          };
        }
      }
      const outcome = await calling.children.dispatch({
        parentRunId: calling.parentRunId,
        agentName: input.agent,
        input: childInput,
        ...(input.parentCancellation === undefined
          ? {}
          : { parentCancellation: input.parentCancellation }),
        ...(context?.meta?.callId === undefined ? {} : { toolCallId: context.meta.callId }),
        ...(calling.principal === undefined ? {} : { principal: calling.principal }),
      });
      return outcome;
    },
  });

  const list = createTool({
    name: 'child-runs-list',
    version: '1.0.0',
    description: 'List the durable child runs owned by this run.',
    metadata: {
      readOnly: true,
      title: 'List child runs',
      shortDescription: 'List owned child runs.',
    },
    input: z.object({}),
    execute: async (_input, context) => {
      const calling = await caller(host, context);
      if (calling === undefined) return { status: 'not-found' as const };
      return {
        status: 'ok' as const,
        children: await calling.children.list(calling.parentRunId, calling),
      };
    },
  });

  const get = createTool({
    name: 'child-runs-get',
    version: '1.0.0',
    description: 'Inspect one durable child run.',
    metadata: { readOnly: true, title: 'Get child run', shortDescription: 'Inspect a child run.' },
    input: referenceInput,
    execute: async (input, context) => {
      const calling = await caller(host, context);
      if (calling === undefined) return { status: 'not-found' as const };
      const child = await calling.children.get({
        ...input,
        parentRunId: calling.parentRunId,
        ...(calling.principal === undefined ? {} : { principal: calling.principal }),
      });
      return child === undefined
        ? { status: 'not-found' as const }
        : { status: 'ok' as const, child };
    },
  });

  const wait = createTool({
    name: 'child-runs-wait',
    version: '1.0.0',
    description: 'Wait durably for one child run to settle.',
    metadata: {
      readOnly: true,
      durableChildWait: true,
      title: 'Wait for child run',
      shortDescription: 'Wait for a child to settle.',
    },
    input: referenceInput,
    execute: async (input, context) => {
      const calling = await caller(host, context);
      if (calling === undefined) return { status: 'not-found' as const };
      const child = await calling.children.get({
        ...input,
        parentRunId: calling.parentRunId,
        ...(calling.principal === undefined ? {} : { principal: calling.principal }),
      });
      if (child === undefined) return { status: 'not-found' as const };
      if (child.status !== 'running') {
        const settled = await calling.children.wait(
          {
            ...input,
            parentRunId: calling.parentRunId,
            ...(calling.principal === undefined ? {} : { principal: calling.principal }),
          },
          { signal: AbortSignal.abort() },
        );
        return settled.outcome === 'not-found'
          ? { status: 'not-found' as const }
          : { status: settled.outcome, child: settled.child };
      }
      const toolCallId = context?.meta?.callId;
      const durableChildWait = context?.executionContext?.['durableChildWait'];
      if (typeof durableChildWait !== 'function' || toolCallId === undefined) {
        return {
          status: 'refused' as const,
          reason: 'Durable child wait is unavailable for this tool call.',
        };
      }
      const parked = durableChildWait({
        childRunId: input.childRunId,
        toolCallId,
      });
      if (parked.parked) return { status: 'pending' as const };
      return {
        status: 'refused' as const,
        reason: parked.reason ?? 'Durable child wait was refused.',
      };
    },
  });

  const cancel = createTool({
    name: 'child-runs-cancel',
    version: '1.0.0',
    description: 'Cancel one running child run.',
    metadata: { mutates: true, title: 'Cancel child run', shortDescription: 'Cancel a child run.' },
    input: referenceInput,
    execute: async (input, context) => {
      const calling = await caller(host, context);
      if (calling === undefined) return { status: 'not-found' as const };
      const outcome = await calling.children.cancel({
        ...input,
        parentRunId: calling.parentRunId,
        ...(calling.principal === undefined ? {} : { principal: calling.principal }),
      });
      return outcome.outcome === 'not-found'
        ? { status: 'not-found' as const }
        : { status: outcome.outcome, child: outcome.child };
    },
  });

  return [dispatch, list, get, wait, cancel];
}
