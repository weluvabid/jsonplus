import { encodeBase64 } from "./base64.js";
import {
  classifyReference,
  isResizableArrayBuffer,
  readArrayBufferByteLength,
  readDataViewState,
  readDateTime,
  readRegExpFlags,
  readRegExpSource,
  readTypedArrayState,
} from "./builtins.js";
import type { ReferenceKind, TypedArrayDescriptor } from "./builtins.js";
import { JSONPlusError } from "./errors.js";
import type {
  ArrayBufferNode,
  ArrayNode,
  DataViewNode,
  DateNode,
  EncodedNode,
  EncodedProperty,
  EncodedValue,
  Envelope,
  JSONPlusOptions,
  MapNode,
  ObjectNode,
  RegExpNode,
  ResolvedLimits,
  SetNode,
  TypedArrayNode,
} from "./internal-types.js";
import { FORMAT, VERSION } from "./internal-types.js";
import { checkCollectionLength, checkString, resolveLimits } from "./options.js";

interface Classification {
  kind: ReferenceKind;
  prototype: "object" | "null" | null;
  typedArray?: TypedArrayDescriptor;
}

interface PendingNode {
  id: number;
  value: object;
  classification: Classification;
}

interface EncodeContext {
  limits: ResolvedLimits;
  seen: WeakMap<object, number>;
  nodes: (EncodedNode | undefined)[];
  queue: PendingNode[];
  edges: number;
  binaryBytes: number;
}

function failUnsupportedProperty(message: string): never {
  throw new JSONPlusError("UNSUPPORTED_PROPERTY", message);
}

function propertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "An own property could not be inspected.", {
      cause,
    });
  }
  if (descriptor === undefined) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "An own property disappeared during inspection.");
  }
  return descriptor;
}

function isArrayIndex(key: string): boolean {
  if (key.length === 0) return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key;
}

function isCanonicalNumericIndexString(key: string): boolean {
  if (key === "-0") return true;
  return String(Number(key)) === key;
}

function encodeValue(value: unknown, context: EncodeContext): EncodedValue {
  if (value === null) return null;

  switch (typeof value) {
    case "undefined":
      return { $type: "undefined" };
    case "boolean":
      return value;
    case "string":
      checkString(value, context.limits, "String value");
      return value;
    case "number":
      if (Number.isNaN(value)) return { $type: "number", value: "nan" };
      if (value === Number.POSITIVE_INFINITY) {
        return { $type: "number", value: "infinity" };
      }
      if (value === Number.NEGATIVE_INFINITY) {
        return { $type: "number", value: "-infinity" };
      }
      if (Object.is(value, -0)) return { $type: "number", value: "-0" };
      return value;
    case "bigint": {
      const bigint = value.toString(10);
      checkString(bigint, context.limits, "BigInt value");
      return { $type: "bigint", value: bigint };
    }
    case "symbol":
      throw new JSONPlusError(
        "UNSUPPORTED_TYPE",
        "Symbol values are unsupported in JSON+ version 1.",
      );
    case "function":
      throw new JSONPlusError(
        "UNSUPPORTED_TYPE",
        "Function values are unsupported in JSON+ version 1.",
      );
    case "object":
      return encodeReference(value, context);
    default:
      throw new JSONPlusError("UNSUPPORTED_TYPE", "This value type is unsupported.");
  }
}

function encodeEdge(value: unknown, context: EncodeContext): EncodedValue {
  context.edges += 1;
  if (context.edges > context.limits.maxEdges) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Graph value slots exceed maxEdges (${context.limits.maxEdges}).`,
    );
  }
  return encodeValue(value, context);
}

function encodeReference(value: object, context: EncodeContext): EncodedValue {
  const existing = context.seen.get(value);
  if (existing !== undefined) return { $ref: existing };

  let classification: Classification;
  try {
    classification = classifyReference(value);
  } catch (error) {
    if (error instanceof JSONPlusError) throw error;
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The object type could not be inspected.", {
      cause: error,
    });
  }

  if (context.nodes.length >= context.limits.maxNodes) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Graph nodes exceed maxNodes (${context.limits.maxNodes}).`,
    );
  }

  const id = context.nodes.length;
  context.seen.set(value, id);
  context.nodes.push(undefined);
  context.queue.push({ id, value, classification });
  return { $ref: id };
}

function encodeProperties(
  value: object,
  context: EncodeContext,
  skipKey?: (key: string) => boolean,
): EncodedProperty[] {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "Own property keys could not be inspected.", {
      cause,
    });
  }

  const properties: EncodedProperty[] = [];
  for (const key of keys) {
    if (typeof key === "symbol") {
      const descriptor = propertyDescriptor(value, key);
      if (descriptor.enumerable) {
        failUnsupportedProperty(
          "Enumerable symbol-keyed properties are unsupported in JSON+ version 1.",
        );
      }
      continue;
    }

    if (skipKey?.(key) === true) continue;
    const descriptor = propertyDescriptor(value, key);
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) {
      failUnsupportedProperty(
        `Enumerable accessor property ${JSON.stringify(key)} is unsupported.`,
      );
    }

    checkString(key, context.limits, "Property key");
    properties.push([key, encodeEdge(descriptor.value, context)]);
    checkCollectionLength(properties.length, context.limits, "Object properties");
  }

  return properties;
}

function encodeArray(value: unknown[], context: EncodeContext): ArrayNode {
  const lengthDescriptor = propertyDescriptor(value, "length");
  if (!("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "Array length could not be inspected safely.");
  }
  const length = lengthDescriptor.value;
  checkCollectionLength(length, context.limits, "Array length");

  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "Array properties could not be inspected.", {
      cause,
    });
  }

  const entries: ArrayNode["entries"] = [];
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key === "symbol") {
      failUnsupportedProperty("Custom array symbol properties are unsupported.");
    }
    if (!isArrayIndex(key)) {
      failUnsupportedProperty(`Custom array property ${JSON.stringify(key)} is unsupported.`);
    }

    const index = Number(key);
    if (index >= length) {
      throw new JSONPlusError("UNSUPPORTED_PROPERTY", "Array index is outside the array length.");
    }

    const descriptor = propertyDescriptor(value, key);
    if (!descriptor.enumerable) {
      failUnsupportedProperty("Non-enumerable array elements are unsupported.");
    }
    if (!("value" in descriptor)) {
      failUnsupportedProperty(`Array accessor at index ${index} is unsupported.`);
    }

    entries.push([index, encodeEdge(descriptor.value, context)]);
    checkCollectionLength(entries.length, context.limits, "Array entries");
  }

  return { type: "array", length, entries };
}

function encodeNode(pending: PendingNode, context: EncodeContext): EncodedNode {
  const { value, classification } = pending;
  switch (classification.kind) {
    case "object": {
      const node: ObjectNode = {
        type: "object",
        prototype: classification.prototype === "null" ? "null" : "object",
        properties: encodeProperties(value, context),
      };
      return node;
    }
    case "array":
      return encodeArray(value as unknown[], context);
    case "date": {
      const time = readDateTime(value);
      const node: DateNode = {
        type: "date",
        time: Number.isNaN(time) ? null : time,
        properties: encodeProperties(value, context),
      };
      return node;
    }
    case "regexp": {
      const lastIndex = propertyDescriptor(value, "lastIndex");
      if (!("value" in lastIndex)) {
        failUnsupportedProperty("RegExp lastIndex must be a data property.");
      }
      const node: RegExpNode = {
        type: "regexp",
        source: readRegExpSource(value),
        flags: readRegExpFlags(value),
        lastIndex: encodeEdge(lastIndex.value, context),
        properties: encodeProperties(value, context),
      };
      checkString(node.source, context.limits, "RegExp source");
      checkString(node.flags, context.limits, "RegExp flags");
      return node;
    }
    case "map": {
      const entries: MapNode["entries"] = [];
      let iterator: IterableIterator<[unknown, unknown]>;
      try {
        iterator = Map.prototype.entries.call(value as Map<unknown, unknown>);
      } catch (cause) {
        throw new JSONPlusError("UNSUPPORTED_TYPE", "The Map object could not be inspected.", {
          cause,
        });
      }
      for (const [key, itemValue] of iterator) {
        entries.push([encodeEdge(key, context), encodeEdge(itemValue, context)]);
        checkCollectionLength(entries.length, context.limits, "Map entries");
      }
      return { type: "map", entries, properties: encodeProperties(value, context) };
    }
    case "set": {
      const values: SetNode["values"] = [];
      let iterator: IterableIterator<unknown>;
      try {
        iterator = Set.prototype.values.call(value as Set<unknown>);
      } catch (cause) {
        throw new JSONPlusError("UNSUPPORTED_TYPE", "The Set object could not be inspected.", {
          cause,
        });
      }
      for (const itemValue of iterator) {
        values.push(encodeEdge(itemValue, context));
        checkCollectionLength(values.length, context.limits, "Set values");
      }
      return { type: "set", values, properties: encodeProperties(value, context) };
    }
    case "array-buffer": {
      if (isResizableArrayBuffer(value)) {
        throw new JSONPlusError(
          "UNSUPPORTED_TYPE",
          "Resizable ArrayBuffers are unsupported in JSON+ version 1.",
        );
      }
      const byteLength = readArrayBufferByteLength(value);
      if (byteLength > context.limits.maxBinaryBytes - context.binaryBytes) {
        throw new JSONPlusError(
          "RESOURCE_LIMIT_EXCEEDED",
          `Binary data exceeds maxBinaryBytes (${context.limits.maxBinaryBytes}).`,
        );
      }
      context.binaryBytes += byteLength;
      const node: ArrayBufferNode = {
        type: "array-buffer",
        bytes: encodeBase64(value as ArrayBuffer),
        properties: encodeProperties(value, context),
      };
      return node;
    }
    case "typed-array": {
      const descriptor = classification.typedArray;
      if (descriptor === undefined) {
        throw new JSONPlusError(
          "UNSUPPORTED_TYPE",
          "Typed-array constructor could not be determined.",
        );
      }
      const state = readTypedArrayState(value);
      checkCollectionLength(state.length, context.limits, "Typed-array length");
      const properties = encodeProperties(value, context, (key) => {
        if (isArrayIndex(key) && Number(key) < state.length) return true;
        if (isCanonicalNumericIndexString(key)) {
          failUnsupportedProperty(
            `Custom numeric typed-array property ${JSON.stringify(key)} is unsupported.`,
          );
        }
        return false;
      });
      const buffer = encodeEdge(state.buffer, context);
      if (typeof buffer !== "object" || buffer === null || !("$ref" in buffer)) {
        throw new JSONPlusError("UNSUPPORTED_TYPE", "Typed-array backing buffer is unsupported.");
      }
      const node: TypedArrayNode = {
        type: "typed-array",
        constructor: descriptor.name,
        buffer,
        byteOffset: state.byteOffset,
        length: state.length,
        properties,
      };
      return node;
    }
    case "data-view": {
      const state = readDataViewState(value);
      const buffer = encodeEdge(state.buffer, context);
      if (typeof buffer !== "object" || buffer === null || !("$ref" in buffer)) {
        throw new JSONPlusError("UNSUPPORTED_TYPE", "DataView backing buffer is unsupported.");
      }
      const node: DataViewNode = {
        type: "data-view",
        buffer,
        byteOffset: state.byteOffset,
        byteLength: state.byteLength,
        properties: encodeProperties(value, context),
      };
      return node;
    }
  }
}

export function encode(value: unknown, options?: JSONPlusOptions): string {
  const limits = resolveLimits(options);
  const context: EncodeContext = {
    limits,
    seen: new WeakMap<object, number>(),
    nodes: [],
    queue: [],
    edges: 0,
    binaryBytes: 0,
  };

  const root = encodeValue(value, context);
  for (let cursor = 0; cursor < context.queue.length; cursor += 1) {
    const pending = context.queue[cursor];
    if (pending === undefined) {
      throw new JSONPlusError("INVALID_NODE", "Encoder queue became inconsistent.");
    }
    context.nodes[pending.id] = encodeNode(pending, context);
  }

  const nodes: EncodedNode[] = [];
  for (const node of context.nodes) {
    if (node === undefined) {
      throw new JSONPlusError("INVALID_NODE", "Encoder produced an uninitialized node.");
    }
    nodes.push(node);
  }

  const envelope: Envelope = { format: FORMAT, version: VERSION, root, nodes };
  let output: string;
  try {
    output = JSON.stringify(envelope);
  } catch (cause) {
    throw new JSONPlusError("INVALID_NODE", "The graph could not be encoded as JSON.", { cause });
  }
  if (output.length > limits.maxOutputChars) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Encoded document exceeds maxOutputChars (${limits.maxOutputChars}).`,
    );
  }
  return output;
}
