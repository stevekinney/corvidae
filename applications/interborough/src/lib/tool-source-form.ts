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
import type {
  SourceToolApproval,
  ToolSourceProbe,
  ToolSourceRequest,
  ToolSourceToolSettings,
} from './host-tool-sources.ts';

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
  /** Whether the source is an MCP server or an OpenAPI service. */
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
  /** The address of the OpenAPI document, when it is fetched. */
  readonly specificationUrl: string;
  /** The text of the OpenAPI file the person chose, or the empty string. */
  readonly document: string;
  /** Where the service is, when the document does not say. */
  readonly baseUrl: string;
  /** How the source signs the request in. */
  readonly authentication: ToolSourceAuthenticationChoice;
  /** The bearer token or the API key. */
  readonly secret: string;
  /** The header an API key is sent in. */
  readonly header: string;
  /**
   * What a person calls the source ("GitHub"), shown in Capabilities and on each tool (COR-2022).
   * Empty, the request names none and the host keeps the one saved, or shows the `id`.
   */
  readonly name: string;
  /** One sentence about the source (COR-2022). Empty, the request names none. */
  readonly description: string;
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
  name: '',
  description: '',
};

/** The fields a missing value can be named for. */
export type ToolSourceFormField =
  'id' | 'url' | 'command' | 'specificationUrl' | 'document' | 'baseUrl' | 'secret' | 'header';

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
  const name = form.name.trim();
  const description = form.description.trim();
  return {
    request: {
      source,
      credentials,
      ...(name === '' ? {} : { name }),
      ...(description === '' ? {} : { description }),
    },
    id,
  };
}

/** What a person chose for one tool under Choose tools (COR-2022): whether it is on, and when it asks. */
export type ToolChoice = {
  /** Whether agents may be given the tool: the row's checkbox. */
  readonly on: boolean;
  /** Its Default asks level: the row's select. */
  readonly approval: SourceToolApproval;
};

/** A tool a probe listed, as Choose tools reads it. */
type ListedTool = Extract<ToolSourceProbe, { outcome: 'listed' }>['tools'][number];

/**
 * The level a tool of capability `tier` starts on (row 33i: "The server's own hints set the starting
 * values; a Dangerous tool starts on Always"): Never for a tool that only reads, Always for a
 * dangerous one, and On changes for one that changes something or declares nothing. The host gives
 * a tool the same level when the source saves none (`tierApproval`).
 */
export function startingApproval(tier: string | null): SourceToolApproval {
  if (tier === 'read-only') return 'never';
  if (tier === 'dangerous') return 'always';
  return 'on-changes';
}

/**
 * Each listed tool's starting choice, keyed by its own name (the probe's `tool`, never the
 * `<id>__<tool>` name). An MCP server's tools all start on; an OpenAPI spec's reads start on and
 * its changes start off (row 33w), because a spec can list many operations nobody asked for.
 */
export function startingToolChoices(
  kind: ToolSourceFormKind,
  tools: readonly Pick<ListedTool, 'tool' | 'tier'>[],
): Record<string, ToolChoice> {
  return Object.fromEntries(
    tools.map(({ tool, tier }) => [
      tool,
      { on: kind === 'mcp' || tier === 'read-only', approval: startingApproval(tier) },
    ]),
  );
}

/**
 * The `tools` a connect sends for `choices` (rows 33i, 34c): `enabled: false` for a tool left
 * off, and the level for a tool whose level differs from the one its tier gives, which the host
 * would give it anyway. A tool on at its tier's level sends nothing. `tiers` is each listed tool's
 * tier by its own name. With no tools, it is empty, and the source joins with none (row 34x).
 */
export function toolSettingsOf(
  choices: Readonly<Record<string, ToolChoice>>,
  tiers: Readonly<Record<string, string | null>>,
): Record<string, ToolSourceToolSettings> {
  const settings: Record<string, ToolSourceToolSettings> = {};
  for (const [tool, choice] of Object.entries(choices)) {
    const tier = Object.hasOwn(tiers, tool) ? (tiers[tool] ?? null) : null;
    const setting: ToolSourceToolSettings = {
      ...(choice.on ? {} : { enabled: false }),
      ...(choice.approval === startingApproval(tier) ? {} : { approval: choice.approval }),
    };
    if (Object.keys(setting).length > 0) settings[tool] = setting;
  }
  return settings;
}

/** How many tools `choices` turns on: the count the footer and "Connect 2 tools" read (row 34c). */
export function chosenToolCount(choices: Readonly<Record<string, ToolChoice>>): number {
  return Object.values(choices).filter((choice) => choice.on).length;
}

/** One row of what a person connected (row 34g): the tool, and its level, or `off` for a tool left off. */
export type ConnectedTool = {
  /** The tool's own name at the source. */
  readonly tool: string;
  /** Its name for a person, or `null` when the source gives none. */
  readonly title: string | null;
  /** The level it asks at, or `off`. */
  readonly approval: SourceToolApproval | 'off';
};

/**
 * What the success state lists (row 34g: "List issues Never, Create issue On changes, Delete branch
 * Off"), in the order the probe listed the tools: each one's level when it is on, and `off` when it
 * is not. A tool with no choice is on at its starting level.
 */
export function connectedTools(
  tools: readonly Pick<ListedTool, 'tool' | 'tier' | 'title'>[],
  choices: Readonly<Record<string, ToolChoice>>,
): ConnectedTool[] {
  return tools.map(({ tool, tier, title }) => {
    const choice = Object.hasOwn(choices, tool) ? choices[tool] : undefined;
    const on = choice?.on ?? true;
    return {
      tool,
      title: title ?? null,
      approval: on ? (choice?.approval ?? startingApproval(tier)) : 'off',
    };
  });
}
