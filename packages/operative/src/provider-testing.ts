/**
 * Operative's provider contract suite — `@lostgradient/operative/provider-testing`.
 *
 * Every model provider has to honor the same shared behavior: it registers under one name, hands
 * its whole configuration (an injected `client` included) to its factory for both the whole-response
 * and the streaming path, attaches the backend descriptor for the model it resolved, and keeps tools
 * the toolbox marks unavailable out of the request. {@link runProviderContract} registers one
 * `bun:test` suite that checks all of it against a single provider, so a provider package runs the
 * suite against itself instead of copying the cases. Only what differs between vendors (the shape of
 * the mock client and of the request it records) comes from the provider, through the subject.
 *
 * A provider's own tests also have to prove what survives the agent loop (a provider-issued call id
 * reaching the next request, say), so the entry exports the two loop seams those tests drive
 * directly, {@link executeLoop} and {@link sealDanglingToolCalls}.
 *
 * Suite registration is deliberately outside the package root, so a runtime consumer never loads
 * `bun:test`.
 *
 * @module operative/provider-testing
 */

import { createTool, createToolbox, type AnyToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { readBackendDescriptors } from './providers/backend-descriptor-attachment.ts';
import { createModelCatalog, type BackendDescriptor } from './providers/model-catalog.ts';
import type { ProviderDefinition } from './providers/provider-definition.ts';
import type { GenerateContext, StreamingHandle } from './types.ts';

export { executeLoop } from './loop.ts';
export { sealDanglingToolCalls } from './run-step-support.ts';

/** A mock vendor client together with the requests it has recorded. */
export interface ProviderContractMockClient<Call extends object = object> {
  /** The client to inject through the `client` field of the provider's configuration. */
  readonly client: unknown;
  /** Every request the mock has received so far, in order. */
  readonly calls: readonly Call[];
}

/**
 * What differs between vendors: which models the suite configures, the text the mock answers with,
 * and how to read a recorded request.
 */
export interface ProviderContractFixtures<Call extends object = object> {
  /** The name the provider's definition registers under. */
  readonly name: string;
  /** A provider-native model identifier the model catalog has a row for. */
  readonly model: string;
  /** A model identifier the model catalog has no row for. */
  readonly unknownModel: string;
  /** The text the mock client's canned response carries, for both the whole and the streamed path. */
  readonly text: string;
  /** Reads the model a recorded request asked for. */
  readModel(call: Call): unknown;
  /** Reads the response-token cap a recorded request carried. */
  readMaximumTokens(call: Call): unknown;
  /** Reads the names of the tools a recorded request offered, or `undefined` when it offered none. */
  readToolNames(call: Call): readonly string[] | undefined;
}

/** The provider a contract suite runs against. */
export interface ProviderContractSubject<Call extends object = object> {
  /** The provider's definition, as a host registers it. */
  readonly definition: ProviderDefinition;
  /**
   * Builds a fresh mock client whose canned response is {@link ProviderContractFixtures.text}.
   *
   * @param shape - `generate` for a client serving the whole-response path, `stream` for one serving
   * the streaming path.
   */
  createMockClient(shape: 'generate' | 'stream'): ProviderContractMockClient<Call>;
  /** The vendor-specific values the suite configures and reads. */
  readonly fixtures: ProviderContractFixtures<Call>;
}

const MAXIMUM_TOKENS = 77;

function makeContext(toolbox: AnyToolbox = createToolbox([])): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
}

function withoutFreshness(descriptor: BackendDescriptor): Omit<BackendDescriptor, 'freshness'> {
  const { freshness: _freshness, ...rest } = descriptor;
  return rest;
}

/**
 * Registers the provider contract as a `bun:test` suite named after the provider.
 *
 * Call it at the top level of a test file, once per provider.
 *
 * @param subject - The provider to check and the vendor-specific values to check it with.
 */
export function runProviderContract<Call extends object>(
  subject: ProviderContractSubject<Call>,
): void {
  const { definition, fixtures } = subject;

  // A variable, not a literal at the call site: `client` is not a field of the shared base
  // configuration, which is exactly the point of passing the whole object through.
  const configure = (model: string, client: unknown, maximumTokens?: number) => ({
    provider: fixtures.name,
    model,
    client,
    ...(maximumTokens === undefined ? {} : { maximumTokens }),
  });

  describe(`${fixtures.name} provider contract`, () => {
    it('names the definition after its provider and fits the string-keyed ProviderDefinition', () => {
      const registered: ProviderDefinition = definition;

      expect(registered.name).toBe(fixtures.name);
    });

    it('passes the whole configuration, including client, to the generate factory', async () => {
      const mock = subject.createMockClient('generate');
      const generate = definition.generate(configure(fixtures.model, mock.client, MAXIMUM_TOKENS));

      const response = await generate(makeContext());

      expect(mock.calls).toHaveLength(1);
      expect(fixtures.readModel(mock.calls[0]!)).toBe(fixtures.model);
      expect(fixtures.readMaximumTokens(mock.calls[0]!)).toBe(MAXIMUM_TOKENS);
      expect(response.content).toBe(fixtures.text);
    });

    it('passes the whole configuration, including client, to the stream factory', async () => {
      const mock = subject.createMockClient('stream');
      const stream = definition.stream(configure(fixtures.model, mock.client, MAXIMUM_TOKENS));

      await stream({ ...makeContext(), streaming: makeStreamingHandle() });

      expect(mock.calls).toHaveLength(1);
      expect(fixtures.readModel(mock.calls[0]!)).toBe(fixtures.model);
      expect(fixtures.readMaximumTokens(mock.calls[0]!)).toBe(MAXIMUM_TOKENS);
    });

    it('attaches exactly the backend descriptor matching the resolved model', () => {
      const mock = subject.createMockClient('generate');
      const generate = definition.generate(configure(fixtures.model, mock.client));
      const expected = createModelCatalog().descriptors.find(
        (descriptor) =>
          descriptor.provider === fixtures.name && descriptor.model === fixtures.model,
      );
      const attached = readBackendDescriptors(generate);

      expect(attached).toHaveLength(1);
      expect(expected).toBeDefined();
      // The factories read the wall clock through the catalog's default `now`, so the comparison
      // strips `freshness` rather than pinning it and checks separately that it is an ISO timestamp.
      expect(withoutFreshness(attached[0]!)).toEqual(withoutFreshness(expected!));
      expect(attached[0]!.freshness).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('attaches no backend descriptor for a model with no catalog row', () => {
      const mock = subject.createMockClient('generate');
      const generate = definition.generate(configure(fixtures.unknownModel, mock.client));

      expect(readBackendDescriptors(generate)).toEqual([]);
    });

    it('omits tools the toolbox marks unavailable from the request payload', async () => {
      const mock = subject.createMockClient('generate');
      const generate = definition.generate(configure(fixtures.model, mock.client));
      const toolbox = createToolbox([
        createTool({
          name: 'available-tool',
          description: 'Available tool',
          input: z.object({}),
          availability: () => true,
          async execute() {
            return 'ok';
          },
        }),
        createTool({
          name: 'unavailable-tool',
          description: 'Unavailable tool',
          input: z.object({}),
          availability: () => false,
          async execute() {
            return 'hidden';
          },
        }),
      ]);

      await generate(makeContext(toolbox));

      expect(fixtures.readToolNames(mock.calls[0]!)).toEqual(['available-tool']);
    });
  });
}
