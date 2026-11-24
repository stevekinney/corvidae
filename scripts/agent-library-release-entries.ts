import armorer from '../packages/armorer/package.json';
import bungalow from '../packages/bungalow/package.json';
import conversationalist from '../packages/conversationalist/package.json';

export const libraryManifests = { armorer, bungalow, conversationalist };

// Workspace manifests expose the imports used in Corvidae. npm also exposes
// the documented entry points of the previously published libraries.
export const releaseEntries = {
  bungalow: bungalow.exports,
  armorer: {
    './mcp': './src/integrations/mcp/index.ts',
    './core': './src/core/index.ts',
    './lazy': './src/create-tool.ts',
    './test': './src/test/index.ts',
    './query': './src/query/index.ts',
    './tools': './src/tools/index.ts',
    './inspect': './src/inspect/index.ts',
    './openapi': './src/integrations/openapi/index.ts',
    './registry': './src/core/registry/index.ts',
    './utilities': './src/utilities/index.ts',
    './middleware': './src/middleware/index.ts',
    './truncation': './src/truncation/index.ts',
    './idempotency': './src/idempotency/index.ts',
    './adapters/gemini': './src/adapters/gemini/index.ts',
    './adapters/openai': './src/adapters/openai/index.ts',
    './instrumentation': './src/instrumentation/index.ts',
    './adapters/anthropic': './src/adapters/anthropic/index.ts',
    './adapters/open-ai/agents': './src/adapters/open-ai/agents/index.ts',
    ...armorer.exports,
  },
  conversationalist: {
    './sort': './src/sort/index.ts',
    './test': './src/test/index.ts',
    './export': './src/export/index.ts',
    './context': './src/context.ts',
    './history': './src/history.ts',
    './message': './src/utilities/message.ts',
    './schemas': './src/schemas.ts',
    './markdown': './src/markdown/index.ts',
    './redaction': './src/plugins/pii-redaction.ts',
    './streaming': './src/streaming.ts',
    './utilities': './src/utilities/index.ts',
    './projection': './src/projection.ts',
    './versioning': './src/versioning/index.ts',
    './composition': './src/composition/index.ts',
    './conversation': './src/conversation/index.ts',
    './adapters/gemini': './src/adapters/gemini/index.ts',
    './adapters/openai': './src/adapters/openai/index.ts',
    './adapters/anthropic': './src/adapters/anthropic/index.ts',
    ...conversationalist.exports,
  },
};
