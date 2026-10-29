import { MemoryStorage } from '@lostgradient/storage';
import {
  Engine,
  WorkflowHandle,
  workflow,
  type EnginePatch,
  type EngineReconfigureResult,
  type RegistryAgnosticEngine,
} from '@lostgradient/weft';

const packageRootWorkflow = workflow({ name: 'packageRootRegistryAgnostic' }).execute(
  async function* () {
    return 'done';
  },
);

async function verifyPackageRootRegistryAgnosticEngine(): Promise<void> {
  const defaultEngine = new Engine({ storage: new MemoryStorage() });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { packageRootWorkflow },
  });

  const defaultRegistryAgnosticEngine: RegistryAgnosticEngine = defaultEngine;
  const concreteRegistryAgnosticEngine: RegistryAgnosticEngine = concreteEngine;

  void defaultRegistryAgnosticEngine.start;
  void concreteRegistryAgnosticEngine.startOrSignal;

  // `reconfigure` stays on the registry-agnostic surface so a host holding only that type can
  // change the live options.
  const patch: EnginePatch = { payloadSize: { maxBytes: 1_024 }, schedulerPollIntervalMs: 250 };
  const reconfigured: EngineReconfigureResult = concreteRegistryAgnosticEngine.reconfigure(patch);
  void defaultRegistryAgnosticEngine.reconfigure({});
  if (reconfigured.outcome === 'applied') {
    const applied: EnginePatch = reconfigured.applied;
    void applied;
  } else {
    const keys: readonly string[] = reconfigured.keys;
    void keys;
  }
  // @ts-expect-error a key outside the patch surface is rejected at compile time.
  void concreteRegistryAgnosticEngine.reconfigure({ maxNestingDepth: 3 });
  // @ts-expect-error a patch value takes the type its engine option takes.
  void concreteRegistryAgnosticEngine.reconfigure({ schedulerPollIntervalMs: '250' });
  void new WorkflowHandle('package-root-workflow-id', concreteRegistryAgnosticEngine);

  // @ts-expect-error registration remains intentionally absent from the registry-agnostic surface.
  void concreteRegistryAgnosticEngine.register;
  // @ts-expect-error bulk registration remains intentionally absent from the registry-agnostic surface.
  void concreteRegistryAgnosticEngine.registerWorkflows;
}

void verifyPackageRootRegistryAgnosticEngine;
