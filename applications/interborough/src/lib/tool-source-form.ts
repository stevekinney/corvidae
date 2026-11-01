/**
 * What the Connect dialog (`routes/capabilities/connect-dialog.svelte`) collects for a tool source,
 * and the request it turns into: Armorer's plain-JSON description (`armorer/tool-sources`, not
 * imported here because it brings the MCP client into the browser) and the value of each credential
 * the description names. The host checks the description again and is the one that refuses a value;
 * this module only refuses what a person has not filled in, so the dialog can name the field.
 *
 * A credential is held in the form until the request is built and goes nowhere else: it is never
 * put in a message, a key, or a description.
 */
import { CAPABILITIES_COPY } from '../app/copy.ts';
import type { ToolSourceRequest } from './host-tool-sources.ts';

/** The pattern an identifier follows: the host refuses any other (`TOOL_SOURCE_IDENTIFIER`). */
export const TOOL_SOURCE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

/** The largest OpenAPI file the dialog reads: the host reads a request body of 4 MB, and the document is most of it. */
export const MAXIMUM_SPECIFICATION_BYTES = 3_000_000;

/** The name of the credential an MCP or OpenAPI bearer token is stored under. */
export const BEARER_CREDENTIAL = 'token';

/** The name of the credential an OpenAPI API key is stored under. */
export const API_KEY_CREDENTIAL = 'key';

/** The kinds of source the dialog connects. */
export type ToolSourceFormKind = 'mcp' | 'openapi';

/** How an MCP server is reached. */
export type ToolSourceTransportChoice = 'http' | 'stdio';

/** Where an OpenAPI document comes from. */
export type ToolSourceSpecificationChoice = 'url' | 'file';

/** How a source authenticates. Which choices apply depends on the kind (`authenticationChoices`). */
export type ToolSourceAuthenticationChoice = 'none' | 'bearer' | 'oauth' | 'api-key';

/** Everything the dialog asks for. */
export type ToolSourceForm = {
  readonly kind: ToolSourceFormKind;
  /** The name the source is saved under, and the prefix of its tools. */
  readonly id: string;
  /** For an MCP server: a URL, or a command on this machine. */
  readonly transport: ToolSourceTransportChoice;
  /** The MCP server's address. */
  readonly url: string;
  /** The command a local MCP server is started with. */
  readonly command: string;
  /** Its arguments, one per line. */
  readonly args: string;
  /** For an OpenAPI service: a URL to the document, or the document itself from a file. */
  readonly specification: ToolSourceSpecificationChoice;
  readonly specificationUrl: string;
  /** The text of the OpenAPI file the person chose, or the empty string. */
  readonly document: string;
  /** Where the service is, when the document does not say. */
  readonly baseUrl: string;
  readonly authentication: ToolSourceAuthenticationChoice;
  /** The bearer token or the API key. */
  readonly secret: string;
  /** The header an API key is sent in. */
  readonly header: string;
};

/** The dialog before anything is filled in. */
export const EMPTY_TOOL_SOURCE_FORM: ToolSourceForm = {
  kind: 'mcp',
  id: '',
  transport: 'http',
  url: '',
  command: '',
  args: '',
  specification: 'url',
  specificationUrl: '',
  document: '',
  baseUrl: '',
  authentication: 'none',
  secret: '',
  header: '',
};

/** The fields a missing value can be named for. */
export type ToolSourceFormField =
  | 'id'
  | 'url'
  | 'command'
  | 'specificationUrl'
  | 'document'
  | 'baseUrl'
  | 'secret'
  | 'header';

/** What building a request came to: the request, or the fields that need a value. */
export type ToolSourceFormResult =
  | { readonly request: ToolSourceRequest; readonly id: string }
  | { readonly errors: Readonly<Partial<Record<ToolSourceFormField, string>>> };

/** The ways the source may authenticate, for the kind and transport chosen. */
export function authenticationChoices(
  form: Pick<ToolSourceForm, 'kind' | 'transport'>,
): readonly ToolSourceAuthenticationChoice[] {
  if (form.kind === 'openapi') return ['none', 'bearer', 'api-key'];
  return form.transport === 'http' ? ['none', 'bearer', 'oauth'] : ['none'];
}

/**
 * The authentication that applies: the one chosen when the kind and transport allow it, and none
 * otherwise (a person who switched from an MCP server with OAuth to an OpenAPI service).
 */
export function effectiveAuthentication(form: ToolSourceForm): ToolSourceAuthenticationChoice {
  return authenticationChoices(form).includes(form.authentication) ? form.authentication : 'none';
}

/** The lines of `text` with something on them, trimmed. */
function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The OpenAPI document in `text`, or `undefined` when it is not a JSON object. */
function parseDocument(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The field of the form a field the host named belongs to (`source.transport.url`,
 * `credentials.token`), or `undefined` when the form has no such field on screen, so the refusal is
 * shown for the whole request instead of under the wrong input.
 */
export function fieldOfHostField(
  field: string,
  form: Pick<ToolSourceForm, 'kind' | 'transport' | 'specification'>,
): ToolSourceFormField | undefined {
  if (field === 'id' || field === 'source.id') return 'id';
  // Only a source with a token or key has a credential, and its field is the one on screen.
  if (field.startsWith('credentials.')) return 'secret';
  if (field === 'source.baseUrl') return form.kind === 'openapi' ? 'baseUrl' : undefined;
  if (field === 'source.transport.url') {
    return form.kind === 'mcp' && form.transport === 'http' ? 'url' : undefined;
  }
  if (field === 'source.transport.command') {
    return form.kind === 'mcp' && form.transport === 'stdio' ? 'command' : undefined;
  }
  if (field === 'source.specification.url') {
    return form.kind === 'openapi' && form.specification === 'url' ? 'specificationUrl' : undefined;
  }
  if (field === 'source.specification.document') {
    return form.kind === 'openapi' && form.specification === 'file' ? 'document' : undefined;
  }
  return undefined;
}

/**
 * Turns the form into the request the host takes, or names the fields that need a value. Only
 * what the choices made apply to is read: the command of an MCP server reached by URL is ignored,
 * so a person who changed their mind is not asked about it.
 */
export function buildToolSourceRequest(form: ToolSourceForm): ToolSourceFormResult {
  const copy = CAPABILITIES_COPY.source.connect.errors;
  const errors: Partial<Record<ToolSourceFormField, string>> = {};
  const id = form.id.trim();
  if (id === '') errors.id = copy.idRequired;
  else if (!TOOL_SOURCE_IDENTIFIER_PATTERN.test(id)) errors.id = copy.idInvalid;

  const authentication = effectiveAuthentication(form);
  const credentials: Record<string, string> = {};
  const secret = form.secret.trim();
  if (authentication === 'bearer' || authentication === 'api-key') {
    if (secret === '') errors.secret = copy.secretRequired[authentication];
    credentials[authentication === 'bearer' ? BEARER_CREDENTIAL : API_KEY_CREDENTIAL] = secret;
  }
  if (authentication === 'api-key' && form.header.trim() === '') {
    errors.header = copy.headerRequired;
  }

  let source: Record<string, unknown> = { id };
  if (form.kind === 'mcp') {
    if (form.transport === 'http') {
      const url = form.url.trim();
      if (url === '') errors.url = copy.urlRequired;
      source = {
        id,
        kind: 'mcp',
        transport: {
          type: 'http',
          url,
          ...(authentication === 'bearer'
            ? { authentication: { type: 'bearer', credential: BEARER_CREDENTIAL } }
            : authentication === 'oauth'
              ? { authentication: { type: 'oauth' } }
              : {}),
        },
      };
    } else {
      const command = form.command.trim();
      if (command === '') errors.command = copy.commandRequired;
      const args = linesOf(form.args);
      source = {
        id,
        kind: 'mcp',
        transport: { type: 'stdio', command, ...(args.length === 0 ? {} : { args }) },
      };
    }
  } else {
    let specification: Record<string, unknown>;
    if (form.specification === 'url') {
      const url = form.specificationUrl.trim();
      if (url === '') errors.specificationUrl = copy.specificationUrlRequired;
      specification = { type: 'url', url };
    } else {
      const document = form.document === '' ? undefined : parseDocument(form.document);
      if (document === undefined) {
        errors.document = form.document === '' ? copy.documentRequired : copy.documentInvalid;
      }
      specification = { type: 'document', document: document ?? {} };
    }
    const baseUrl = form.baseUrl.trim();
    source = {
      id,
      kind: 'openapi',
      specification,
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(authentication === 'bearer'
        ? { authentication: { type: 'bearer', credential: BEARER_CREDENTIAL } }
        : authentication === 'api-key'
          ? {
              authentication: {
                type: 'api-key',
                header: form.header.trim(),
                credential: API_KEY_CREDENTIAL,
              },
            }
          : {}),
    };
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { request: { source, credentials }, id };
}
