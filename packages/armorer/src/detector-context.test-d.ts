import type { DetectorContext, InputDetector } from './index';

// A context built without `memory` (and without `signal`) still compiles.
const withoutMemory: DetectorContext = {
  step: 0,
  conversationLength: 0,
  sessionTainted: false,
  provenance: 'user-input',
};

// So does one with it, as governed memory builds it.
const withMemory: DetectorContext = {
  ...withoutMemory,
  memory: { source: 'conversation', memoryClass: 'episodic', trust: 'untrusted' },
};

// A detector written before the field existed still compiles, and one may read it.
const detector: InputDetector = {
  name: 'reads-the-record',
  detect: async (_input, context) => ({
    triggered: context.memory?.trust === 'untrusted',
    confidence: 0,
    category: 'none',
  }),
};

// Each field is required once `memory` is present.
const missingTrust: DetectorContext = {
  ...withoutMemory,
  // @ts-expect-error `trust` is required when `memory` is given.
  memory: { source: 'conversation', memoryClass: 'episodic' },
};

// `memory` is read-only to a detector.
// @ts-expect-error A detector cannot change the record it was told about.
withMemory.memory!.source = 'system';

void [detector, missingTrust];
