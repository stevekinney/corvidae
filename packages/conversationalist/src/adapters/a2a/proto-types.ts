/**
 * Hand-written TypeScript mirror of the A2A messages this adapter uses.
 *
 * Source: `specification/a2a.proto` in https://github.com/a2aproject/A2A at
 * tag `v1.0.1`, commit `3303592588e388e62e0f69f701af531d2f4e3991`
 * (proto package `lf.a2a.v1`). Only `Part`, `Role`, `Message`, and `Artifact`
 * are mirrored; transport, task, and agent-card messages are out of scope.
 *
 * The shapes follow the proto3 JSON mapping that A2A's JSON-RPC and HTTP+JSON
 * bindings put on the wire: field names are lowerCamelCase, `bytes` is a base64
 * string, `google.protobuf.Value` is any JSON value, `google.protobuf.Struct`
 * is a JSON object, and enum values are their names. A proto3 scalar left at
 * its default (an empty string or empty list) is absent from the JSON form, so
 * those fields are optional here.
 *
 * No protobuf toolchain or generated code is involved; update these types by
 * hand when the pinned proto revision changes.
 */
import type { JSONValue } from '../../types';

/** `google.protobuf.Struct` in its proto3 JSON form. */
export type A2AStruct = Record<string, JSONValue>;

/** Fields `Part` carries alongside its `content` oneof. */
interface A2APartFields {
  /** Optional metadata associated with this part. */
  metadata?: A2AStruct;
  /** An optional filename for the file (for example `document.pdf`). */
  filename?: string;
  /** The MIME type of the part content; available for every part kind. */
  mediaType?: string;
}

/** `Part.content` oneof member `string text = 1`. */
export interface A2ATextPart extends A2APartFields {
  text: string;
  raw?: never;
  url?: never;
  data?: never;
}

/** `Part.content` oneof member `bytes raw = 2`, base64-encoded in JSON. */
export interface A2ARawPart extends A2APartFields {
  raw: string;
  text?: never;
  url?: never;
  data?: never;
}

/** `Part.content` oneof member `string url = 3`. */
export interface A2AUrlPart extends A2APartFields {
  url: string;
  text?: never;
  raw?: never;
  data?: never;
}

/** `Part.content` oneof member `google.protobuf.Value data = 4`. */
export interface A2ADataPart extends A2APartFields {
  data: JSONValue;
  text?: never;
  raw?: never;
  url?: never;
}

/**
 * `Part`: a container for one section of communication content. Exactly one
 * member of the `content` oneof is set.
 */
export type A2APart = A2ATextPart | A2ARawPart | A2AUrlPart | A2ADataPart;

/** `Role`: the sender of a message. */
export type A2ARole = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

/** `Message`: one unit of communication between client and server. */
export interface A2AMessage {
  /** Required. Unique identifier created by the message creator. */
  messageId: string;
  contextId?: string;
  taskId?: string;
  /** Required. */
  role: A2ARole;
  /** Required. */
  parts: A2APart[];
  metadata?: A2AStruct;
  extensions?: string[];
  referenceTaskIds?: string[];
}

/** `Artifact`: a task output. */
export interface A2AArtifact {
  /** Required. Unique within a task. */
  artifactId: string;
  name?: string;
  description?: string;
  /** Required. Must contain at least one part. */
  parts: A2APart[];
  metadata?: A2AStruct;
  extensions?: string[];
}
