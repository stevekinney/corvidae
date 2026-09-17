<script lang="ts">
  import { AgentRunError, createAgent } from '@repo/operative';
  import { appendUserMessage, createConversationHistory } from '@repo/conversationalist';
  import { createToolbox } from '@repo/armorer';
  import { z } from 'zod';

  // The result contract for a typed agent, measured rather than assumed.
  //
  // The headline, and the reason this route exists: a schema-invalid run and
  // a valid one are INDISTINGUISHABLE by `finishReason`. Both settle
  // `stop-condition`. The invalid one carries no `result.error` at all. A
  // consumer that checks the finish reason and stops there ships a bug —
  // it will treat garbage as an answer.
  //
  // What separates them on the terminal result is `schemaValidation.success`
  // and `output` — which is absent on the invalid run — plus the rejection
  // from `unwrap()` / `output()`. What does NOT separate them is the pair a
  // caller reaches for first: `finishReason` and `error`.
  //
  // `output` being absent is a weaker signal than it looks, though: a schema
  // whose valid parse is `undefined` would make it useless, and it says
  // nothing about WHY. `schemaValidation.success` is the field that answers
  // the question directly.
  //
  // Every fixture here is a local function. No network, no key, no fixture
  // server — the whole point is that the contract is observable without any
  // of that.

  const answerSchema = z.object({ answer: z.string() });
  const conversation = appendUserMessage(
    createConversationHistory({ id: 'exercise-output' }),
    'What is the answer?',
  );

  type OutputRunResult = {
    error?: unknown;
    finishReason: string;
    output?: unknown;
    schemaValidation?: { success: boolean; error?: unknown } | undefined;
  };

  type AccessorFailures = {
    unwrapThrew: boolean;
    outputThrew: boolean;
    unwrapError: unknown;
    outputError: unknown;
  };

  function describeThrownResult(threw: boolean, value: unknown): string {
    if (!threw) return '(resolved)';
    return value instanceof Error
      ? value.name
      : `(non-Error: ${value === undefined ? 'undefined' : typeof value})`;
  }

  async function readAccessorFailures(run: {
    unwrap: () => Promise<unknown>;
    output: () => Promise<unknown>;
  }): Promise<AccessorFailures> {
    let unwrapThrew = false;
    let outputThrew = false;
    let unwrapError: unknown;
    let outputError: unknown;
    try {
      await run.unwrap();
    } catch (error) {
      unwrapThrew = true;
      unwrapError = error;
    }
    try {
      await run.output();
    } catch (error) {
      outputThrew = true;
      outputError = error;
    }
    return { unwrapThrew, outputThrew, unwrapError, outputError };
  }

  type Observation = {
    finishReason: string;
    schemaValid: boolean;
    hasResultError: boolean;
    output: string;
    unwrapError: string;
    outputError: string;
    sameErrorInstance: boolean;
    errorKind: string;
    errorCode: string;
    schemaErrorKind: string;
    schemaErrorCode: string;
  };

  function schemaErrorOf(result: OutputRunResult) {
    const schemaErrorValue =
      result.schemaValidation?.success === false ? result.schemaValidation.error : undefined;
    return schemaErrorValue instanceof AgentRunError ? schemaErrorValue : undefined;
  }

  function outputValueOf(output: unknown): string {
    return output === undefined ? '(none)' : JSON.stringify(output);
  }

  function accessorErrorFields(failures: AccessorFailures) {
    const failure =
      failures.unwrapError instanceof AgentRunError ? failures.unwrapError : undefined;
    return {
      unwrapError: describeThrownResult(failures.unwrapThrew, failures.unwrapError),
      outputError: describeThrownResult(failures.outputThrew, failures.outputError),
      sameErrorInstance:
        failures.unwrapThrew &&
        failures.outputThrew &&
        failures.unwrapError === failures.outputError,
      errorKind: failure?.kind ?? '(none)',
      errorCode: failure?.code ?? '(none)',
    };
  }

  function schemaErrorFields(schemaError: AgentRunError | undefined) {
    return {
      schemaErrorKind: schemaError?.kind ?? '(none)',
      schemaErrorCode: schemaError?.code ?? '(none)',
    };
  }

  function observeResult(input: {
    result: OutputRunResult;
    failures: AccessorFailures;
  }): Observation {
    const { result, failures } = input;
    const schemaError = schemaErrorOf(result);
    return {
      finishReason: result.finishReason,
      schemaValid: result.schemaValidation?.success === true,
      hasResultError: result.error !== undefined,
      output: outputValueOf(result.output),
      ...accessorErrorFields(failures),
      ...schemaErrorFields(schemaError),
    };
  }

  /**
   * Runs one agent whose `generate` always answers with `content`, and reports
   * every field a caller might reach for when deciding whether it worked.
   *
   * `unwrap()` and `output()` are both called, and their rejections compared
   * by IDENTITY rather than by shape — `result()` caches, and the same cached
   * error is what both accessors are documented to surface. Comparing
   * messages would pass even if each call minted a fresh error.
   */
  async function observe(content: string): Promise<Observation> {
    const agent = createAgent({
      generate: async () => ({ content, toolCalls: [] }),
      toolbox: createToolbox([]),
      output: answerSchema,
    });
    const run = agent.run({ conversation });
    const result = await run.result();

    // `threw` rather than `!== undefined`: `throw undefined` is legal, and
    // reading the absence of a value as "it resolved" would report the
    // opposite of what happened — in a panel whose entire subject is a
    // failure that is easy to miss.
    const failures = await readAccessorFailures(run);
    return observeResult({ result, failures });
  }

  const valid = observe(JSON.stringify({ answer: 'forty-two' }));
  const invalid = observe(JSON.stringify({ answer: 42 }));
</script>

<main>
  <h1>Output validation</h1>
  <p>
    A typed agent settles <code>stop-condition</code> whether or not its output satisfies the schema.
    The finish reason cannot tell you which happened.
  </p>

  {#each [{ id: 'valid', label: 'Valid output', promise: valid }, { id: 'invalid', label: 'Invalid output', promise: invalid }] as panel (panel.id)}
    <section data-testid="output-{panel.id}" aria-live="polite">
      <h2>{panel.label}</h2>
      {#await panel.promise}
        <p data-testid="output-{panel.id}-pending">Running…</p>
      {:then observation}
        <dl>
          <dt>finishReason</dt>
          <dd data-testid="output-{panel.id}-finish">{observation.finishReason}</dd>
          <dt>schemaValidation.success</dt>
          <dd data-testid="output-{panel.id}-schema-valid">{observation.schemaValid}</dd>
          <dt>result.error present</dt>
          <dd data-testid="output-{panel.id}-has-error">{observation.hasResultError}</dd>
          <dt>result.output</dt>
          <dd data-testid="output-{panel.id}-output">{observation.output}</dd>
          <dt>unwrap()</dt>
          <dd data-testid="output-{panel.id}-unwrap">{observation.unwrapError}</dd>
          <dt>output()</dt>
          <dd data-testid="output-{panel.id}-output-method">{observation.outputError}</dd>
          <dt>same error instance</dt>
          <dd data-testid="output-{panel.id}-same-instance">{observation.sameErrorInstance}</dd>
          <dt>kind / code (from the rejection)</dt>
          <dd data-testid="output-{panel.id}-kind-code">
            {observation.errorKind} / {observation.errorCode}
          </dd>
          <dt>kind / code (from schemaValidation.error)</dt>
          <dd data-testid="output-{panel.id}-schema-kind-code">
            {observation.schemaErrorKind} / {observation.schemaErrorCode}
          </dd>
        </dl>
      {/await}
    </section>
  {/each}
</main>

<style>
  main {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
    font-family: monospace;
  }
</style>
