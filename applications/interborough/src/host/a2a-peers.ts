/** Startup configuration and host tools for authenticated A2A peers. */

import type { BureauOptions } from '@lostgradient/bureau';
import { sha256HexSync } from '@lostgradient/cryptography';
import { createPeerCallTool, type PeerCallJournal } from '@lostgradient/operative';
import { createA2APeerClient, type EgressPolicy } from '@lostgradient/weft/a2a';
import type { Tool } from 'armorer';
import { createTool } from 'armorer';
import { z } from 'zod';

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { TOOL_SOURCE_IDENTIFIER } from './tool-sources-configuration.ts';

/** One startup-configured external A2A peer. */
export type ConfiguredA2APeer = {
  /** Stable identifier used in the tool name. */
  readonly id: string;
  /** Description shown to the model. */
  readonly description: string;
  /** Canonical peer base URL. */
  readonly url: string;
  /** Optional Bungalow secret name for the bearer credential. */
  readonly bearerSecret?: string;
};

const NO_PEERS: readonly ConfiguredA2APeer[] = Object.freeze([]);

function peerToolVersion(peer: ConfiguredA2APeer): string {
  return sha256HexSync(
    JSON.stringify(['a2a-peer', peer.id, peer.url, ['message:string'], { mutates: true }]),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((entry) => redactSecret(entry, secret));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactSecret(entry, secret)]),
    );
  }
  return value;
}

function redactText(value: string, secret: string): string {
  return value.split(secret).join('[REDACTED]');
}

function redactError(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const scrubbed = new Error(redactText(message, secret));
  scrubbed.name = error instanceof Error ? error.name : 'Error';
  return scrubbed;
}

function parsePeer(value: unknown, location: string, field: string): ConfiguredA2APeer {
  if (!isObject(value))
    throw new ProviderConfigurationError(location, field, 'expected an object.');
  for (const key of Object.keys(value)) {
    if (!['id', 'description', 'url', 'bearerSecret'].includes(key)) {
      throw new ProviderConfigurationError(location, `${field}.${key}`, 'not a known field.');
    }
  }
  const id = value['id'];
  const description = value['description'];
  const url = value['url'];
  const bearerSecret = value['bearerSecret'];
  if (typeof id !== 'string' || !TOOL_SOURCE_IDENTIFIER.test(id)) {
    throw new ProviderConfigurationError(
      location,
      `${field}.id`,
      'expected a valid peer identifier.',
    );
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new ProviderConfigurationError(location, `${field}.description`, 'expected text.');
  }
  if (typeof url !== 'string') {
    throw new ProviderConfigurationError(location, `${field}.url`, 'expected a URL.');
  }
  let canonicalUrl: string;
  try {
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') throw new Error('credentials');
    canonicalUrl = parsed.href;
  } catch {
    throw new ProviderConfigurationError(
      location,
      `${field}.url`,
      'expected an absolute URL without credentials.',
    );
  }
  if (bearerSecret !== undefined && (typeof bearerSecret !== 'string' || bearerSecret === '')) {
    throw new ProviderConfigurationError(
      location,
      `${field}.bearerSecret`,
      'expected a secret name.',
    );
  }
  return Object.freeze({
    id,
    description,
    url: canonicalUrl,
    ...(bearerSecret === undefined ? {} : { bearerSecret }),
  });
}

/** Parses the `a2aPeers` value from configuration JSON. */
export function parseA2APeersConfiguration(
  value: unknown,
  location: string,
): readonly ConfiguredA2APeer[] {
  if (value === undefined) return NO_PEERS;
  if (!Array.isArray(value))
    throw new ProviderConfigurationError(location, 'a2aPeers', 'expected a list.');
  const peers = value.map((entry, index) => parsePeer(entry, location, `a2aPeers[${index}]`));
  const seen = new Set<string>();
  for (const [index, peer] of peers.entries()) {
    if (seen.has(peer.id)) {
      throw new ProviderConfigurationError(
        location,
        `a2aPeers[${index}].id`,
        'another peer has this identifier.',
      );
    }
    seen.add(peer.id);
  }
  return peers;
}

/** Reads and parses the host configuration file's `a2aPeers` key. */
export function readA2APeersConfiguration(
  text: string | undefined,
  location: string,
): readonly ConfiguredA2APeer[] {
  if (text === undefined) return NO_PEERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(location, 'the file', 'it is not valid JSON.');
  }
  if (!isObject(parsed))
    throw new ProviderConfigurationError(location, 'the file', 'expected a JSON object.');
  return parseA2APeersConfiguration(parsed['a2aPeers'], location);
}

/** Dependencies used to build configured peer tools before Bureau starts. */
export type A2APeerToolOptions = {
  /** Peers to expose as tools. */
  readonly peers: readonly ConfiguredA2APeer[];
  /** Reads a Bungalow secret without exposing its value. */
  readonly readSecret: (key: string) => string | undefined;
  /** Fetch implementation for the peer transport; tests use this to observe JSON-RPC boundaries. */
  readonly fetch?: typeof fetch;
  /** Egress policy applied before card and task requests. */
  readonly egressPolicy?: EgressPolicy;
  /** The journal handoff installed before Bureau boot recovery. */
  readonly peerCalls?: PeerCallJournal;
  /** Receives attach-only adapters keyed by the wrapper tool's canonical revision. */
  readonly recoverableStartedApprovals?: Map<string, RecoverableStartedApproval>;
  /** Receives startup diagnostics. */
  readonly warn: (message: string) => void;
};

type RecoverableStartedApproval =
  NonNullable<BureauOptions['recoverableStartedApprovals']> extends ReadonlyMap<
    string,
    infer Approval
  >
    ? Approval
    : never;

/** Builds the peer tools before Bureau starts; the journal resolves lazily after it exists. */
export function createA2APeerTools(options: A2APeerToolOptions): Readonly<Record<string, Tool>> {
  const tools: Record<string, Tool> = {};
  for (const peer of options.peers) {
    const secret =
      peer.bearerSecret === undefined ? undefined : options.readSecret(peer.bearerSecret);
    if (peer.bearerSecret !== undefined && secret === undefined) {
      options.warn(
        `Configured A2A peer "${peer.id}" was omitted because its bearer secret is missing.`,
      );
      continue;
    }
    const client = createA2APeerClient({
      url: peer.url,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      egressPolicy: options.egressPolicy,
      ...(secret === undefined
        ? {}
        : { authenticate: () => ({ authorization: `Bearer ${secret}` }) }),
    });
    const durable = options.peerCalls;
    if (durable === undefined) {
      options.warn(
        `Configured A2A peer "${peer.id}" was omitted because its journal is unavailable.`,
      );
      continue;
    }
    const peerTool = createPeerCallTool({
      name: `a2a-peer:${peer.id}`,
      description: peer.description,
      peer: client,
      peerUrl: peer.url,
      durable,
      ...(secret === undefined
        ? {}
        : { redactPeerText: (value: string) => redactText(value, secret) }),
    });
    const tool = createTool({
      name: peer.id,
      namespace: 'a2a-peer',
      version: peerToolVersion(peer),
      description: peer.description,
      input: z.object({ message: z.string().describe('What to tell the peer agent.') }).strict(),
      metadata: { mutates: true, title: `Call A2A peer ${peer.id}` },
      execute: async (input, context) => {
        try {
          const result = await peerTool.rawExecute(input, context);
          return secret === undefined ? result : redactSecret(result, secret);
        } catch (error) {
          if (secret === undefined) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes(secret)) throw error;
          const scrubbed = new Error(message.split(secret).join('[REDACTED]'));
          scrubbed.name = error instanceof Error ? error.name : 'Error';
          throw scrubbed;
        }
      },
    });
    tools[peerTool.name] = tool;
    options.recoverableStartedApprovals?.set(tool.id, {
      version: 1,
      attach: async (input) => {
        try {
          const task = await client.attach({
            taskId: input.journalEntry.taskId,
            contextId: input.journalEntry.contextId,
            signal: input.signal,
          });
          const outcome = await task.result();
          const successful = outcome.state === 'completed';
          const safeMessage =
            secret === undefined ? outcome.message : redactText(outcome.message, secret);
          return {
            callId: input.callId,
            toolCallId: input.callId,
            toolName: tool.name,
            outcome: successful ? 'success' : 'error',
            content: safeMessage,
            result: successful
              ? secret === undefined
                ? {
                    untrusted: true,
                    provenance: outcome.provenance,
                    taskId: outcome.taskId,
                    contextId: outcome.contextId,
                    message: outcome.message,
                    artifacts: outcome.artifacts,
                  }
                : redactSecret(
                    {
                      untrusted: true,
                      provenance: outcome.provenance,
                      taskId: outcome.taskId,
                      contextId: outcome.contextId,
                      message: outcome.message,
                      artifacts: outcome.artifacts,
                    },
                    secret,
                  )
              : `Peer task ended ${outcome.state}.`,
          };
        } catch (error) {
          if (secret === undefined) throw error;
          throw redactError(error, secret);
        }
      },
    });
  }
  return Object.freeze(tools);
}
