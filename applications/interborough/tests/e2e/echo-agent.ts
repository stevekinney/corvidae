/**
 * The agent the attachment specs talk to (COR-1548). Its model is a catalog row that takes images
 * in and, unlike any real row, puts images out, so the Bureau lets a person attach an image to it
 * and admits the image it sends back. Its hand-written `generate` answers a message that carries
 * images with one inline image part for each image in that message and says how many it echoed.
 * The Bureau admits each part it returns as a new asset, so a returned image has an identifier of
 * its own and is never the one that was sent.
 */
import {
  createAgent,
  createModelCatalog,
  stopWhen,
  withBackendDescriptors,
  type BackendDescriptor,
  type GenerateContext,
  type GenerateResponse,
} from '@lostgradient/operative';

export const ECHO_AGENT_NAME = 'echo';

/** What the echo says when it was sent no image. */
export const ECHO_NOTHING_REPLY = 'There was no image to echo.';

/** The first Anthropic catalog row, made to put images out as well as take them in. */
function imageOutputDescriptor(): BackendDescriptor {
  const row = createModelCatalog().descriptors.find(
    (descriptor) => descriptor.provider === 'anthropic',
  );
  if (row === undefined) throw new Error('The model catalog holds no Anthropic row.');
  return {
    ...row,
    modalities: { ...row.modalities, image: { ...row.modalities.image, output: true } },
  };
}

/** The id of the latest user row, which is the message this step answers. */
function latestUserMessageId(context: GenerateContext): string | undefined {
  return context.conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .at(-1)?.id;
}

async function echo(context: GenerateContext): Promise<GenerateResponse> {
  const asked = latestUserMessageId(context);
  const images = [...(context.resolvedSources ?? [])].flatMap(([key, resolved]) => {
    const { source, mimeType } = resolved;
    if (asked === undefined || !key.startsWith(`${asked}:`)) return [];
    if (source.kind !== 'inline' || source.encoding !== 'base64') return [];
    // Only an image is echoed; a document or any other file is read and left unanswered.
    if (mimeType === undefined || !mimeType.startsWith('image/')) return [];
    return [{ type: 'image' as const, mimeType, source }];
  });
  const content = images.length === 0 ? ECHO_NOTHING_REPLY : `Echoed ${images.length} image.`;
  return {
    content,
    parts: [{ type: 'text', text: content }, ...images],
    toolCalls: [],
  };
}

export function createEchoAgents() {
  return {
    [ECHO_AGENT_NAME]: createAgent({
      name: ECHO_AGENT_NAME,
      description: 'Sends back each image it is given.',
      generate: withBackendDescriptors(echo, [imageOutputDescriptor()]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}
