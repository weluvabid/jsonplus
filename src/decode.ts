import { base64EncodedByteLength, decodeBase64 } from "./base64.js";
import { TYPED_ARRAY_BY_NAME } from "./builtins.js";
import { JSONPlusError } from "./errors.js";
import type {
  EncodedNode,
  EncodedValue,
  JSONPlusOptions,
  ResolvedLimits,
} from "./internal-types.js";
import { FORMAT, VERSION } from "./internal-types.js";
import { checkCollectionLength, checkString, resolveLimits } from "./options.js";

const MAX_DATE_TIME = 8.64e15;
const CANONICAL_BIGINT = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;
const REGEXP_FLAG_ORDER = "dgimsuvy";

interface ValidationContext {
  limits: ResolvedLimits;
  nodeCount: number;
  edges: number;
  binaryBytes: number;
  binaryByteLengths: WeakMap<EncodedNode, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JSONContainer = { kind: "object"; keys: Set<string> } | { kind: "array" };

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return 0;
}

function decodeJSONStringToken(
  input: string,
  start: number,
  end: number,
  firstEscape: number,
): string {
  const contentStart = start + 1;
  const contentEnd = end - 1;
  if (firstEscape < 0 || firstEscape >= contentEnd) {
    return input.slice(contentStart, contentEnd);
  }

  const parts: string[] = [];
  let segmentStart = contentStart;
  for (let index = firstEscape; index < contentEnd; ) {
    if (input.charCodeAt(index) !== 92) {
      index += 1;
      continue;
    }

    parts.push(input.slice(segmentStart, index));
    const escaped = input.charCodeAt(index + 1);
    switch (escaped) {
      case 34:
        parts.push('"');
        index += 2;
        break;
      case 92:
        parts.push("\\");
        index += 2;
        break;
      case 47:
        parts.push("/");
        index += 2;
        break;
      case 98:
        parts.push("\b");
        index += 2;
        break;
      case 102:
        parts.push("\f");
        index += 2;
        break;
      case 110:
        parts.push("\n");
        index += 2;
        break;
      case 114:
        parts.push("\r");
        index += 2;
        break;
      case 116:
        parts.push("\t");
        index += 2;
        break;
      case 117: {
        const code =
          (hexDigit(input.charCodeAt(index + 2)) << 12) |
          (hexDigit(input.charCodeAt(index + 3)) << 8) |
          (hexDigit(input.charCodeAt(index + 4)) << 4) |
          hexDigit(input.charCodeAt(index + 5));
        parts.push(String.fromCharCode(code));
        index += 6;
        break;
      }
      default:
        index += 2;
        break;
    }
    segmentStart = index;
  }
  parts.push(input.slice(segmentStart, contentEnd));
  return parts.join("");
}

function assertNoDuplicateObjectKeys(input: string): void {
  const containers: JSONContainer[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "{") {
      containers.push({ kind: "object", keys: new Set<string>() });
      continue;
    }
    if (character === "[") {
      containers.push({ kind: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    let escaped = false;
    let firstEscape = -1;
    for (index += 1; index < input.length; index += 1) {
      const current = input[index];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        if (firstEscape < 0) firstEscape = index;
        escaped = true;
      } else if (current === '"') {
        break;
      }
    }

    const end = index + 1;
    let next = end;
    while (next < input.length) {
      const code = input.charCodeAt(next);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      next += 1;
    }

    if (input[next] === ":") {
      const container = containers[containers.length - 1];
      if (container?.kind !== "object") {
        throw new JSONPlusError("INVALID_INPUT", "Object key appears outside an object.");
      }

      const key = decodeJSONStringToken(input, start, end, firstEscape);
      if (container.keys.has(key)) {
        throw new JSONPlusError(
          "INVALID_INPUT",
          `Duplicate JSON object member ${JSON.stringify(key)} is not allowed.`,
        );
      }
      container.keys.add(key);
    }

    index = end - 1;
  }
}

function isReferenceToken(value: unknown): value is { $ref: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "$ref") &&
    typeof (value as { $ref?: unknown }).$ref === "number"
  );
}

function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new JSONPlusError("INVALID_NODE", `${context} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!keys.includes(key)) {
      throw new JSONPlusError(
        "INVALID_NODE",
        `${context} contains unknown field ${JSON.stringify(key)}.`,
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new JSONPlusError(
        "INVALID_NODE",
        `${context} is missing field ${JSON.stringify(key)}.`,
      );
    }
  }
}

function assertEnvelopeKeys(value: Record<string, unknown>): void {
  const keys = new Set(["format", "version", "root", "nodes"]);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new JSONPlusError(
        "INVALID_ENVELOPE",
        `Envelope contains unknown field ${JSON.stringify(key)}.`,
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new JSONPlusError(
        "INVALID_ENVELOPE",
        `Envelope is missing field ${JSON.stringify(key)}.`,
      );
    }
  }
}

function assertSafeInteger(
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new JSONPlusError("INVALID_NODE", `${context} must be a valid non-negative integer.`);
  }
  return value;
}

function readReference(value: unknown, context: string, nodeCount: number): number {
  if (!isRecord(value)) {
    throw new JSONPlusError("INVALID_REFERENCE", `${context} must be a reference tag.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "$ref") {
    throw new JSONPlusError("INVALID_REFERENCE", `${context} must contain only a $ref field.`);
  }
  const id = value["$ref"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id >= nodeCount) {
    throw new JSONPlusError("INVALID_REFERENCE", `${context} points to a nonexistent node.`);
  }
  return id;
}

function validateValue(value: unknown, context: ValidationContext, isEdge: boolean): void {
  if (isEdge) {
    context.edges += 1;
    if (context.edges > context.limits.maxEdges) {
      throw new JSONPlusError(
        "RESOURCE_LIMIT_EXCEEDED",
        `Graph value slots exceed maxEdges (${context.limits.maxEdges}).`,
      );
    }
  }

  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    checkString(value, context.limits, "String value");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new JSONPlusError(
        "INVALID_TAG",
        "Non-finite numbers and negative zero must use explicit JSON+ number tags.",
      );
    }
    return;
  }
  if (!isRecord(value)) {
    throw new JSONPlusError("INVALID_TAG", "Value is not a valid JSON+ value token.");
  }

  if (Object.hasOwn(value, "$ref")) {
    readReference(value, "Value reference", context.nodeCount);
    return;
  }
  if (!Object.hasOwn(value, "$type")) {
    throw new JSONPlusError("INVALID_TAG", "Object values must use a recognized JSON+ tag.");
  }

  const type = value["$type"];
  if (type === "undefined") {
    if (Object.keys(value).length !== 1) {
      throw new JSONPlusError("INVALID_TAG", "Undefined tag contains unexpected fields.");
    }
    return;
  }
  if (type === "bigint") {
    assertExactKeys(value, ["$type", "value"], "BigInt tag");
    const digits = value["value"];
    if (typeof digits !== "string" || !CANONICAL_BIGINT.test(digits)) {
      throw new JSONPlusError("INVALID_TAG", "BigInt tag contains a non-canonical decimal value.");
    }
    checkString(digits, context.limits, "BigInt value");
    return;
  }
  if (type === "number") {
    assertExactKeys(value, ["$type", "value"], "Number tag");
    const numberTag = value["value"];
    if (
      numberTag !== "nan" &&
      numberTag !== "infinity" &&
      numberTag !== "-infinity" &&
      numberTag !== "-0"
    ) {
      throw new JSONPlusError("INVALID_TAG", "Number tag contains an unknown special value.");
    }
    return;
  }

  throw new JSONPlusError("INVALID_TAG", "Unknown JSON+ value tag.");
}

function validateReferenceSlot(
  value: unknown,
  context: ValidationContext,
  slotName: string,
): number {
  context.edges += 1;
  if (context.edges > context.limits.maxEdges) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Graph value slots exceed maxEdges (${context.limits.maxEdges}).`,
    );
  }
  return readReference(value, slotName, context.nodeCount);
}

function validateProperties(
  value: unknown,
  context: ValidationContext,
  nodeType: EncodedNode["type"],
): EncodedValue[] {
  if (!Array.isArray(value)) {
    throw new JSONPlusError("INVALID_NODE", `${nodeType} properties must be an array.`);
  }
  if (value.length % 2 !== 0) {
    throw new JSONPlusError("INVALID_NODE", `${nodeType} properties must contain key/value pairs.`);
  }
  const propertyCount = value.length / 2;
  checkCollectionLength(propertyCount, context.limits, `${nodeType} properties`);
  if (propertyCount === 0) return value as EncodedValue[];

  const seenKeys = new Set<string>();
  for (let index = 0; index < value.length; index += 2) {
    const key: unknown = value[index];
    if (typeof key !== "string") {
      throw new JSONPlusError("INVALID_NODE", `${nodeType} property keys must be strings.`);
    }
    checkString(key, context.limits, "Property key");
    if (seenKeys.has(key)) {
      throw new JSONPlusError(
        "INVALID_NODE",
        `${nodeType} contains duplicate property ${JSON.stringify(key)}.`,
      );
    }
    seenKeys.add(key);

    if (nodeType === "regexp" && key === "lastIndex") {
      throw new JSONPlusError(
        "INVALID_NODE",
        "RegExp lastIndex is represented by its dedicated field.",
      );
    }
    if (nodeType === "typed-array" && isCanonicalNumericIndexString(key)) {
      throw new JSONPlusError(
        "INVALID_NODE",
        "Typed-array properties cannot use numeric index keys.",
      );
    }

    validateValue(value[index + 1], context, true);
  }
  return value as EncodedValue[];
}

function isCanonicalNumericIndexString(key: string): boolean {
  if (key === "-0") return true;
  return String(Number(key)) === key;
}

function validateNode(candidate: unknown, context: ValidationContext): EncodedNode {
  assertRecord(candidate, "Node");
  const type = candidate["type"];

  switch (type) {
    case "object": {
      assertExactKeys(candidate, ["type", "prototype", "properties"], "Object node");
      if (candidate["prototype"] !== "object" && candidate["prototype"] !== "null") {
        throw new JSONPlusError("INVALID_NODE", "Object prototype must be 'object' or 'null'.");
      }
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "array": {
      assertExactKeys(candidate, ["type", "length", "entries"], "Array node");
      const length = assertSafeInteger(candidate["length"], "Array length", 0xffff_ffff);
      checkCollectionLength(length, context.limits, "Array length");
      const entries = candidate["entries"];
      if (!Array.isArray(entries)) {
        throw new JSONPlusError("INVALID_NODE", "Array entries must be an array.");
      }
      if (entries.length % 2 !== 0) {
        throw new JSONPlusError("INVALID_NODE", "Array entries must contain index/value pairs.");
      }
      const entryCount = entries.length / 2;
      checkCollectionLength(entryCount, context.limits, "Array entries");
      const useIndexBitset = entryCount > 0 && length <= 64_000_000 && entryCount * 256 >= length;
      const seenBits = useIndexBitset ? new Uint8Array(Math.ceil(length / 8)) : undefined;
      const seenIndices = entryCount > 0 && !useIndexBitset ? new Set<number>() : undefined;
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 2) {
        const index = assertSafeInteger(entries[entryIndex], "Array index", 0xffff_fffe);
        if (index >= length) {
          throw new JSONPlusError("INVALID_NODE", "Array entry index is outside the array length.");
        }
        if (seenBits !== undefined) {
          const byteIndex = index >>> 3;
          const mask = 1 << (index & 7);
          const flags = seenBits[byteIndex] ?? 0;
          if ((flags & mask) !== 0) {
            throw new JSONPlusError("INVALID_NODE", `Array contains duplicate index ${index}.`);
          }
          seenBits[byteIndex] = flags | mask;
        } else if (seenIndices !== undefined) {
          if (seenIndices.has(index)) {
            throw new JSONPlusError("INVALID_NODE", `Array contains duplicate index ${index}.`);
          }
          seenIndices.add(index);
        }
        validateValue(entries[entryIndex + 1], context, true);
      }
      return candidate as unknown as EncodedNode;
    }
    case "date": {
      assertExactKeys(candidate, ["type", "time", "properties"], "Date node");
      const time = candidate["time"];
      if (
        time !== null &&
        (typeof time !== "number" || !Number.isSafeInteger(time) || Math.abs(time) > MAX_DATE_TIME)
      ) {
        throw new JSONPlusError(
          "INVALID_NODE",
          "Date timestamp must be null or a valid Date timestamp.",
        );
      }
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "regexp": {
      assertExactKeys(
        candidate,
        ["type", "source", "flags", "lastIndex", "properties"],
        "RegExp node",
      );
      const source = candidate["source"];
      const flags = candidate["flags"];
      if (typeof source !== "string" || typeof flags !== "string") {
        throw new JSONPlusError("INVALID_NODE", "RegExp source and flags must be strings.");
      }
      checkString(source, context.limits, "RegExp source");
      checkString(flags, context.limits, "RegExp flags");
      let previousFlagIndex = -1;
      let hasUnicode = false;
      let hasUnicodeSets = false;
      let invalidFlags = false;
      for (let index = 0; index < flags.length; index += 1) {
        const flagIndex = REGEXP_FLAG_ORDER.indexOf(flags[index] ?? "");
        if (flagIndex < 0 || flagIndex <= previousFlagIndex) {
          invalidFlags = true;
          break;
        }
        previousFlagIndex = flagIndex;
        if (flags[index] === "u") hasUnicode = true;
        if (flags[index] === "v") hasUnicodeSets = true;
      }
      if (invalidFlags || (hasUnicode && hasUnicodeSets)) {
        throw new JSONPlusError(
          "INVALID_NODE",
          "RegExp flags must be unique and in canonical order.",
        );
      }
      validateValue(candidate["lastIndex"], context, true);
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "map": {
      assertExactKeys(candidate, ["type", "entries", "properties"], "Map node");
      const entries = candidate["entries"];
      if (!Array.isArray(entries)) {
        throw new JSONPlusError("INVALID_NODE", "Map entries must be an array.");
      }
      if (entries.length % 2 !== 0) {
        throw new JSONPlusError("INVALID_NODE", "Map entries must contain key/value pairs.");
      }
      checkCollectionLength(entries.length / 2, context.limits, "Map entries");
      for (let index = 0; index < entries.length; index += 2) {
        validateValue(entries[index], context, true);
        validateValue(entries[index + 1], context, true);
      }
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "set": {
      assertExactKeys(candidate, ["type", "values", "properties"], "Set node");
      const values = candidate["values"];
      if (!Array.isArray(values)) {
        throw new JSONPlusError("INVALID_NODE", "Set values must be an array.");
      }
      checkCollectionLength(values.length, context.limits, "Set values");
      for (let index = 0; index < values.length; index += 1) {
        validateValue(values[index], context, true);
      }
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "array-buffer": {
      assertExactKeys(candidate, ["type", "bytes", "properties"], "ArrayBuffer node");
      const bytes = candidate["bytes"];
      if (typeof bytes !== "string") {
        throw new JSONPlusError("INVALID_BINARY", "ArrayBuffer bytes must be a base64 string.");
      }
      let byteLength: number;
      try {
        // This is constant-time with respect to the payload; alphabet/canonical checks happen
        // once in decodeBase64 while decoding the bytes.
        byteLength = base64EncodedByteLength(bytes);
      } catch (error) {
        if (error instanceof JSONPlusError) throw error;
        throw new JSONPlusError("INVALID_BINARY", "ArrayBuffer base64 is invalid.", {
          cause: error,
        });
      }
      if (byteLength > context.limits.maxBinaryBytes - context.binaryBytes) {
        throw new JSONPlusError(
          "RESOURCE_LIMIT_EXCEEDED",
          `Binary data exceeds maxBinaryBytes (${context.limits.maxBinaryBytes}).`,
        );
      }
      context.binaryBytes += byteLength;
      context.binaryByteLengths.set(candidate as unknown as EncodedNode, byteLength);
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "typed-array": {
      assertExactKeys(
        candidate,
        ["type", "constructor", "buffer", "byteOffset", "length", "properties"],
        "Typed-array node",
      );
      const constructor = candidate["constructor"];
      if (typeof constructor !== "string" || !TYPED_ARRAY_BY_NAME.has(constructor)) {
        throw new JSONPlusError("INVALID_NODE", "Typed-array constructor is unsupported.");
      }
      assertSafeInteger(candidate["byteOffset"], "Typed-array byteOffset");
      const length = assertSafeInteger(candidate["length"], "Typed-array length");
      checkCollectionLength(length, context.limits, "Typed-array length");
      validateReferenceSlot(candidate["buffer"], context, "Typed-array buffer reference");
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    case "data-view": {
      assertExactKeys(
        candidate,
        ["type", "buffer", "byteOffset", "byteLength", "properties"],
        "DataView node",
      );
      assertSafeInteger(candidate["byteOffset"], "DataView byteOffset");
      assertSafeInteger(candidate["byteLength"], "DataView byteLength");
      validateReferenceSlot(candidate["buffer"], context, "DataView buffer reference");
      validateProperties(candidate["properties"], context, type);
      return candidate as unknown as EncodedNode;
    }
    default:
      throw new JSONPlusError("INVALID_NODE", "Unknown JSON+ node type.");
  }
}

function validateBufferViews(
  nodes: EncodedNode[],
  binaryByteLengths: WeakMap<EncodedNode, number>,
): void {
  for (const node of nodes) {
    if (node.type !== "typed-array" && node.type !== "data-view") continue;
    const referenced = nodes[node.buffer.$ref];
    if (referenced === undefined || referenced.type !== "array-buffer") {
      throw new JSONPlusError(
        "INVALID_REFERENCE",
        `${node.type} buffer must reference an ArrayBuffer node.`,
      );
    }

    const bufferLength = binaryByteLengths.get(referenced);
    if (bufferLength === undefined) {
      throw new JSONPlusError("INVALID_REFERENCE", "ArrayBuffer byte length was not validated.");
    }
    if (node.type === "typed-array") {
      const descriptor = TYPED_ARRAY_BY_NAME.get(node.constructor);
      if (descriptor === undefined) {
        throw new JSONPlusError("INVALID_NODE", "Typed-array constructor is unsupported.");
      }
      if (node.byteOffset % descriptor.bytesPerElement !== 0) {
        throw new JSONPlusError("INVALID_NODE", "Typed-array byteOffset is not element-aligned.");
      }
      if (
        node.byteOffset > bufferLength ||
        node.length > Math.floor((bufferLength - node.byteOffset) / descriptor.bytesPerElement)
      ) {
        throw new JSONPlusError("INVALID_NODE", "Typed-array view exceeds its backing buffer.");
      }
    } else if (node.byteOffset > bufferLength || node.byteLength > bufferLength - node.byteOffset) {
      throw new JSONPlusError("INVALID_NODE", "DataView exceeds its backing buffer.");
    }
  }
}

function visitFlatPairs(values: EncodedValue[], visit: (value: EncodedValue) => void): void {
  for (let index = 1; index < values.length; index += 2) {
    const value = values[index];
    if (value !== undefined) visit(value);
  }
}

function visitNodeValues(node: EncodedNode, visit: (value: EncodedValue) => void): void {
  switch (node.type) {
    case "object":
    case "date":
    case "array-buffer":
      visitFlatPairs(node.properties, visit);
      break;
    case "typed-array":
    case "data-view":
      visitFlatPairs(node.properties, visit);
      visit(node.buffer);
      break;
    case "array":
      visitFlatPairs(node.entries, visit);
      break;
    case "regexp":
      visit(node.lastIndex);
      visitFlatPairs(node.properties, visit);
      break;
    case "map":
      for (const value of node.entries) visit(value);
      visitFlatPairs(node.properties, visit);
      break;
    case "set":
      for (const value of node.values) visit(value);
      visitFlatPairs(node.properties, visit);
      break;
  }
}

function validateReachability(root: EncodedValue, nodes: EncodedNode[]): void {
  const reached = new Uint8Array(Math.ceil(nodes.length / 8));
  // Mark nodes when enqueued, not when popped: every node enters the stack at most once.
  // The stack is therefore bounded by node count rather than graph edge count.
  const stack = new Uint32Array(nodes.length);
  let stackLength = 0;

  const enqueue = (id: number): void => {
    const byteIndex = id >>> 3;
    const mask = 1 << (id & 7);
    const flags = reached[byteIndex] ?? 0;
    if ((flags & mask) !== 0) return;
    reached[byteIndex] = flags | mask;
    stack[stackLength] = id;
    stackLength += 1;
  };
  const visit = (value: EncodedValue): void => {
    if (isReferenceToken(value)) enqueue(value.$ref);
  };

  if (isReferenceToken(root)) enqueue(root.$ref);
  while (stackLength > 0) {
    stackLength -= 1;
    const id = stack[stackLength];
    if (id === undefined) continue;
    const node = nodes[id];
    if (node === undefined) {
      throw new JSONPlusError("INVALID_REFERENCE", "Reference points to a nonexistent node.");
    }
    visitNodeValues(node, visit);
  }

  for (let id = 0; id < nodes.length; id += 1) {
    const isReached = ((reached[id >>> 3] ?? 0) & (1 << (id & 7))) !== 0;
    if (!isReached) {
      throw new JSONPlusError(
        "UNREACHABLE_NODE",
        `Node ${id} is not reachable from the root value.`,
      );
    }
  }
}

interface ValidatedDocument {
  root: EncodedValue;
  nodes: EncodedNode[];
  binaryByteLengths: WeakMap<EncodedNode, number>;
}

function flattenVersionOnePairs(value: unknown, fieldName: string): void {
  if (!Array.isArray(value)) return;
  const pairCount = value.length;

  for (let index = 0; index < pairCount; index += 1) {
    const pair: unknown = value[index];
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new JSONPlusError("INVALID_NODE", `${fieldName} entry ${index} must be a pair.`);
    }
  }

  value.length = pairCount * 2;
  for (let index = pairCount - 1; index >= 0; index -= 1) {
    const pair = value[index] as unknown[];
    value[index * 2] = pair[0];
    value[index * 2 + 1] = pair[1];
  }
}

function normalizeVersionOneNodes(nodes: unknown[]): void {
  for (const candidate of nodes) {
    if (!isRecord(candidate)) continue;
    const type = candidate["type"];
    if (type === "array") {
      flattenVersionOnePairs(candidate["entries"], "Array entries");
      continue;
    }
    if (type === "map") flattenVersionOnePairs(candidate["entries"], "Map entries");
    if (
      type === "object" ||
      type === "date" ||
      type === "regexp" ||
      type === "map" ||
      type === "set" ||
      type === "array-buffer" ||
      type === "typed-array" ||
      type === "data-view"
    ) {
      flattenVersionOnePairs(candidate["properties"], `${type} properties`);
    }
  }
}

function validateDocument(raw: unknown, limits: ResolvedLimits): ValidatedDocument {
  assertRecord(raw, "Envelope");
  assertEnvelopeKeys(raw);
  if (raw["format"] !== FORMAT) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Unrecognized JSON+ format identifier.");
  }
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Version must be a positive integer.");
  }
  if (version !== 1 && version !== VERSION) {
    throw new JSONPlusError("UNSUPPORTED_VERSION", `JSON+ version ${version} is not supported.`);
  }
  const rawNodes = raw["nodes"];
  if (!Array.isArray(rawNodes)) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Envelope nodes must be an array.");
  }
  if (rawNodes.length > limits.maxNodes) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Node count exceeds maxNodes (${limits.maxNodes}).`,
    );
  }

  if (version === 1) normalizeVersionOneNodes(rawNodes);

  const binaryByteLengths = new WeakMap<EncodedNode, number>();
  const context: ValidationContext = {
    limits,
    nodeCount: rawNodes.length,
    edges: 0,
    binaryBytes: 0,
    binaryByteLengths,
  };
  validateValue(raw["root"], context, false);

  // JSON.parse already produced private data structures. Validate them in place without
  // duplicating the node table or pair buffers.
  const nodes = rawNodes as EncodedNode[];
  for (let nodeId = 0; nodeId < nodes.length; nodeId += 1) {
    validateNode(nodes[nodeId], context);
  }
  validateBufferViews(nodes, binaryByteLengths);
  validateReachability(raw["root"] as EncodedValue, nodes);

  return { root: raw["root"] as EncodedValue, nodes, binaryByteLengths };
}

function resolveValue(value: EncodedValue, nodes: unknown[]): unknown {
  if (value === null || typeof value !== "object") return value;
  if ("$ref" in value) {
    const resolved = nodes[value.$ref];
    if (resolved === undefined) {
      throw new JSONPlusError("INVALID_REFERENCE", "A reference was not allocated.");
    }
    return resolved;
  }
  if (value.$type === "undefined") return undefined;
  if (value.$type === "bigint") {
    try {
      return BigInt(value.value);
    } catch (cause) {
      throw new JSONPlusError("INVALID_TAG", "BigInt value could not be reconstructed.", { cause });
    }
  }
  switch (value.value) {
    case "nan":
      return Number.NaN;
    case "infinity":
      return Number.POSITIVE_INFINITY;
    case "-infinity":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
  }
}

function allocateGraph(
  nodes: EncodedNode[],
  binaryByteLengths: WeakMap<EncodedNode, number>,
): unknown[] {
  const allocated: unknown[] = new Array(nodes.length);

  for (let id = 0; id < nodes.length; id += 1) {
    const node = nodes[id];
    if (node?.type !== "array-buffer") continue;
    try {
      const byteLength = binaryByteLengths.get(node);
      if (byteLength === undefined) {
        throw new JSONPlusError("INVALID_BINARY", "ArrayBuffer byte length was not validated.");
      }
      allocated[id] = decodeBase64(node.bytes, byteLength);
    } catch (cause) {
      if (cause instanceof JSONPlusError) throw cause;
      throw new JSONPlusError("INVALID_BINARY", "ArrayBuffer bytes could not be decoded.", {
        cause,
      });
    }
  }

  for (let id = 0; id < nodes.length; id += 1) {
    const node = nodes[id];
    if (
      node === undefined ||
      node.type === "array-buffer" ||
      node.type === "typed-array" ||
      node.type === "data-view"
    ) {
      continue;
    }

    try {
      switch (node.type) {
        case "object":
          allocated[id] = node.prototype === "null" ? Object.create(null) : {};
          break;
        case "array":
          allocated[id] = new Array(node.length);
          break;
        case "date":
          allocated[id] = new Date(node.time === null ? Number.NaN : node.time);
          break;
        case "regexp": {
          const regexp = new RegExp(node.source, node.flags);
          if (regexp.source !== node.source || regexp.flags !== node.flags) {
            throw new JSONPlusError("INVALID_NODE", "RegExp source or flags are not canonical.");
          }
          allocated[id] = regexp;
          break;
        }
        case "map":
          allocated[id] = new Map<unknown, unknown>();
          break;
        case "set":
          allocated[id] = new Set<unknown>();
          break;
      }
    } catch (cause) {
      if (cause instanceof JSONPlusError) throw cause;
      throw new JSONPlusError("INVALID_NODE", `Node ${id} could not be allocated.`, { cause });
    }
  }

  for (let id = 0; id < nodes.length; id += 1) {
    const node = nodes[id];
    if (node === undefined || (node.type !== "typed-array" && node.type !== "data-view")) continue;
    const buffer = allocated[node.buffer.$ref];
    if (!(buffer instanceof ArrayBuffer)) {
      throw new JSONPlusError(
        "INVALID_REFERENCE",
        `Node ${id} does not reference an allocated ArrayBuffer.`,
      );
    }

    try {
      if (node.type === "typed-array") {
        const descriptor = TYPED_ARRAY_BY_NAME.get(node.constructor);
        if (descriptor === undefined) {
          throw new JSONPlusError("INVALID_NODE", "Typed-array constructor is unsupported.");
        }
        allocated[id] = descriptor.create(buffer, node.byteOffset, node.length);
      } else {
        allocated[id] = new DataView(buffer, node.byteOffset, node.byteLength);
      }
    } catch (cause) {
      if (cause instanceof JSONPlusError) throw cause;
      throw new JSONPlusError("INVALID_NODE", `View node ${id} could not be allocated.`, { cause });
    }
  }

  return allocated;
}

function defineProperties(target: object, properties: EncodedValue[], allocated: unknown[]): void {
  for (let index = 0; index < properties.length; index += 2) {
    const key = properties[index] as string;
    const value = properties[index + 1] as EncodedValue;
    try {
      Object.defineProperty(target, key, {
        value: resolveValue(value, allocated),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch (cause) {
      if (cause instanceof JSONPlusError) throw cause;
      throw new JSONPlusError(
        "INVALID_NODE",
        `Property ${JSON.stringify(key)} could not be restored.`,
        { cause },
      );
    }
  }
}

function populateGraph(nodes: EncodedNode[], allocated: unknown[]): void {
  for (let id = 0; id < nodes.length; id += 1) {
    const node = nodes[id];
    const target = allocated[id];
    if (node === undefined || typeof target !== "object" || target === null) {
      throw new JSONPlusError("INVALID_NODE", `Node ${id} was not allocated.`);
    }

    switch (node.type) {
      case "object":
      case "date":
      case "array-buffer":
      case "typed-array":
      case "data-view":
        defineProperties(target, node.properties, allocated);
        break;
      case "array":
        for (let index = 0; index < node.entries.length; index += 2) {
          const arrayIndex = node.entries[index] as number;
          const value = node.entries[index + 1] as EncodedValue;
          Object.defineProperty(target, String(arrayIndex), {
            value: resolveValue(value, allocated),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        break;
      case "regexp": {
        const regexp = target as RegExp;
        Object.defineProperty(regexp, "lastIndex", {
          value: resolveValue(node.lastIndex, allocated),
        });
        defineProperties(regexp, node.properties, allocated);
        break;
      }
      case "map": {
        const map = target as Map<unknown, unknown>;
        for (let index = 0; index < node.entries.length; index += 2) {
          const key = resolveValue(node.entries[index] as EncodedValue, allocated);
          if (map.has(key)) {
            throw new JSONPlusError("INVALID_NODE", "Map node contains duplicate keys.");
          }
          map.set(key, resolveValue(node.entries[index + 1] as EncodedValue, allocated));
        }
        defineProperties(map, node.properties, allocated);
        break;
      }
      case "set": {
        const set = target as Set<unknown>;
        for (const encodedValue of node.values) {
          const value = resolveValue(encodedValue, allocated);
          if (set.has(value)) {
            throw new JSONPlusError("INVALID_NODE", "Set node contains duplicate values.");
          }
          set.add(value);
        }
        defineProperties(set, node.properties, allocated);
        break;
      }
    }
  }
}

export function decode(input: string, options?: JSONPlusOptions): unknown {
  if (typeof input !== "string") {
    throw new JSONPlusError("INVALID_INPUT", "JSON+ input must be a string.");
  }
  const limits = resolveLimits(options);
  if (input.length > limits.maxInputChars) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Input exceeds maxInputChars (${limits.maxInputChars}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (cause) {
    throw new JSONPlusError("INVALID_INPUT", "Input is not valid JSON.", { cause });
  }

  assertNoDuplicateObjectKeys(input);
  const document = validateDocument(parsed, limits);
  const allocated = allocateGraph(document.nodes, document.binaryByteLengths);
  populateGraph(document.nodes, allocated);
  return resolveValue(document.root, allocated);
}
