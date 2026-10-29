export const FORMAT = "jsonplus" as const;
export const VERSION = 2 as const;

export type NumberTag = "nan" | "infinity" | "-infinity" | "-0";

export type EncodedValue =
  | null
  | boolean
  | string
  | number
  | { $ref: number }
  | { $type: "undefined" }
  | { $type: "bigint"; value: string }
  | { $type: "number"; value: NumberTag };

interface NodeWithProperties {
  /** Version 2 uses an alternating key/value buffer. */
  properties: EncodedValue[];
}

export interface ObjectNode extends NodeWithProperties {
  type: "object";
  prototype: "object" | "null";
}

export interface ArrayNode {
  type: "array";
  length: number;
  /** Alternating index/value entries. */
  entries: EncodedValue[];
}

export interface DateNode extends NodeWithProperties {
  type: "date";
  time: number | null;
}

export interface RegExpNode extends NodeWithProperties {
  type: "regexp";
  source: string;
  flags: string;
  lastIndex: EncodedValue;
}

export interface MapNode extends NodeWithProperties {
  type: "map";
  /** Alternating key/value entries. */
  entries: EncodedValue[];
}

export interface SetNode extends NodeWithProperties {
  type: "set";
  values: EncodedValue[];
}

export interface ArrayBufferNode extends NodeWithProperties {
  type: "array-buffer";
  bytes: string;
}

export interface TypedArrayNode extends NodeWithProperties {
  type: "typed-array";
  constructor: string;
  buffer: { $ref: number };
  byteOffset: number;
  length: number;
}

export interface DataViewNode extends NodeWithProperties {
  type: "data-view";
  buffer: { $ref: number };
  byteOffset: number;
  byteLength: number;
}

export type EncodedNode =
  | ObjectNode
  | ArrayNode
  | DateNode
  | RegExpNode
  | MapNode
  | SetNode
  | ArrayBufferNode
  | TypedArrayNode
  | DataViewNode;

export interface Envelope {
  format: typeof FORMAT;
  version: typeof VERSION;
  root: EncodedValue;
  nodes: EncodedNode[];
}

export interface JSONPlusOptions {
  maxNodes?: number;
  maxEdges?: number;
  maxBinaryBytes?: number;
  maxStringLength?: number;
  maxCollectionEntries?: number;
  maxInputChars?: number;
  maxOutputChars?: number;
}

export interface ResolvedLimits {
  maxNodes: number;
  maxEdges: number;
  maxBinaryBytes: number;
  maxStringLength: number;
  maxCollectionEntries: number;
  maxInputChars: number;
  maxOutputChars: number;
}
