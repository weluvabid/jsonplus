import { base64ByteLength, decodeBase64 } from "./base64.js";
import { TYPED_ARRAYS } from "./builtins.js";
import { JSONPlusError } from "./errors.js";
import type {
  ArrayNode,
  EncodedNode,
  EncodedProperty,
  EncodedValue,
  Envelope,
  JSONPlusOptions,
  MapNode,
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JSONContainer = { kind: "object"; keys: Set<string> } | { kind: "array" };

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
    for (index += 1; index < input.length; index += 1) {
      const current = input[index];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
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

      const key = JSON.parse(input.slice(start, end)) as string;
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
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value["$ref"] === "number" &&
    Number.isSafeInteger(value["$ref"])
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
  const expected = new Set(keys);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expected.has(key)) {
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
): EncodedProperty[] {
  if (!Array.isArray(value)) {
    throw new JSONPlusError("INVALID_NODE", `${nodeType} properties must be an array.`);
  }
  checkCollectionLength(value.length, context.limits, `${nodeType} properties`);

  const seenKeys = new Set<string>();
  const properties: EncodedProperty[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!Array.isArray(candidate) || candidate.length !== 2) {
      throw new JSONPlusError(
        "INVALID_NODE",
        `${nodeType} property ${index} must be a key/value pair.`,
      );
    }
    const key = candidate[0];
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

    validateValue(candidate[1], context, true);
    properties.push([key, candidate[1] as EncodedValue]);
  }
  return properties;
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
      return {
        type,
        prototype: candidate["prototype"],
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    case "array": {
      assertExactKeys(candidate, ["type", "length", "entries"], "Array node");
      const length = assertSafeInteger(candidate["length"], "Array length", 0xffff_ffff);
      checkCollectionLength(length, context.limits, "Array length");
      if (!Array.isArray(candidate["entries"])) {
        throw new JSONPlusError("INVALID_NODE", "Array entries must be an array.");
      }
      checkCollectionLength(candidate["entries"].length, context.limits, "Array entries");
      const seenIndices = new Set<number>();
      const entries: ArrayNode["entries"] = [];
      for (const [entryIndex, entry] of candidate["entries"].entries()) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new JSONPlusError(
            "INVALID_NODE",
            `Array entry ${entryIndex} must be an index/value pair.`,
          );
        }
        const index = assertSafeInteger(entry[0], "Array index", 0xffff_fffe);
        if (index >= length) {
          throw new JSONPlusError("INVALID_NODE", "Array entry index is outside the array length.");
        }
        if (seenIndices.has(index)) {
          throw new JSONPlusError("INVALID_NODE", `Array contains duplicate index ${index}.`);
        }
        seenIndices.add(index);
        validateValue(entry[1], context, true);
        entries.push([index, entry[1] as EncodedValue]);
      }
      return { type, length, entries };
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
      return {
        type,
        time,
        properties: validateProperties(candidate["properties"], context, type),
      };
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
      const invalidFlags =
        [...flags].some(
          (flag, index) => REGEXP_FLAG_ORDER.indexOf(flag) < 0 || flags.indexOf(flag) !== index,
        ) ||
        [...flags]
          .sort((left, right) => REGEXP_FLAG_ORDER.indexOf(left) - REGEXP_FLAG_ORDER.indexOf(right))
          .join("") !== flags ||
        (flags.includes("u") && flags.includes("v"));
      if (invalidFlags) {
        throw new JSONPlusError(
          "INVALID_NODE",
          "RegExp flags must be unique and in canonical order.",
        );
      }
      validateValue(candidate["lastIndex"], context, true);
      return {
        type,
        source,
        flags,
        lastIndex: candidate["lastIndex"] as EncodedValue,
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    case "map": {
      assertExactKeys(candidate, ["type", "entries", "properties"], "Map node");
      if (!Array.isArray(candidate["entries"])) {
        throw new JSONPlusError("INVALID_NODE", "Map entries must be an array.");
      }
      checkCollectionLength(candidate["entries"].length, context.limits, "Map entries");
      const entries: MapNode["entries"] = [];
      for (const [index, entry] of candidate["entries"].entries()) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new JSONPlusError("INVALID_NODE", `Map entry ${index} must be a key/value pair.`);
        }
        validateValue(entry[0], context, true);
        validateValue(entry[1], context, true);
        entries.push([entry[0] as EncodedValue, entry[1] as EncodedValue]);
      }
      return {
        type,
        entries,
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    case "set": {
      assertExactKeys(candidate, ["type", "values", "properties"], "Set node");
      if (!Array.isArray(candidate["values"])) {
        throw new JSONPlusError("INVALID_NODE", "Set values must be an array.");
      }
      checkCollectionLength(candidate["values"].length, context.limits, "Set values");
      const values: EncodedValue[] = [];
      for (const item of candidate["values"]) {
        validateValue(item, context, true);
        values.push(item as EncodedValue);
      }
      return {
        type,
        values,
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    case "array-buffer": {
      assertExactKeys(candidate, ["type", "bytes", "properties"], "ArrayBuffer node");
      const bytes = candidate["bytes"];
      if (typeof bytes !== "string") {
        throw new JSONPlusError("INVALID_BINARY", "ArrayBuffer bytes must be a base64 string.");
      }
      let byteLength: number;
      try {
        byteLength = base64ByteLength(bytes);
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
      return {
        type,
        bytes,
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    case "typed-array": {
      assertExactKeys(
        candidate,
        ["type", "constructor", "buffer", "byteOffset", "length", "properties"],
        "Typed-array node",
      );
      const constructor = candidate["constructor"];
      if (
        typeof constructor !== "string" ||
        !TYPED_ARRAYS.some((item) => item.name === constructor)
      ) {
        throw new JSONPlusError("INVALID_NODE", "Typed-array constructor is unsupported.");
      }
      const byteOffset = assertSafeInteger(candidate["byteOffset"], "Typed-array byteOffset");
      const length = assertSafeInteger(candidate["length"], "Typed-array length");
      checkCollectionLength(length, context.limits, "Typed-array length");
      const buffer = validateReferenceSlot(
        candidate["buffer"],
        context,
        "Typed-array buffer reference",
      );
      return {
        type,
        constructor,
        buffer: { $ref: buffer },
        byteOffset,
        length,
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    case "data-view": {
      assertExactKeys(
        candidate,
        ["type", "buffer", "byteOffset", "byteLength", "properties"],
        "DataView node",
      );
      const byteOffset = assertSafeInteger(candidate["byteOffset"], "DataView byteOffset");
      const byteLength = assertSafeInteger(candidate["byteLength"], "DataView byteLength");
      const buffer = validateReferenceSlot(
        candidate["buffer"],
        context,
        "DataView buffer reference",
      );
      return {
        type,
        buffer: { $ref: buffer },
        byteOffset,
        byteLength,
        properties: validateProperties(candidate["properties"], context, type),
      };
    }
    default:
      throw new JSONPlusError("INVALID_NODE", "Unknown JSON+ node type.");
  }
}

function validateBufferViews(nodes: EncodedNode[]): void {
  for (const node of nodes) {
    if (node.type !== "typed-array" && node.type !== "data-view") continue;
    const referenced = nodes[node.buffer.$ref];
    if (referenced === undefined || referenced.type !== "array-buffer") {
      throw new JSONPlusError(
        "INVALID_REFERENCE",
        `${node.type} buffer must reference an ArrayBuffer node.`,
      );
    }

    const bufferLength = base64ByteLength(referenced.bytes);
    if (node.type === "typed-array") {
      const descriptor = TYPED_ARRAYS.find((item) => item.name === node.constructor);
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

function visitNodeValues(node: EncodedNode, visit: (value: EncodedValue) => void): void {
  switch (node.type) {
    case "object":
    case "date":
    case "array-buffer":
    case "typed-array":
    case "data-view":
      for (const [, value] of node.properties) visit(value);
      if (node.type === "typed-array" || node.type === "data-view") visit(node.buffer);
      break;
    case "array":
      for (const [, value] of node.entries) visit(value);
      break;
    case "regexp":
      visit(node.lastIndex);
      for (const [, value] of node.properties) visit(value);
      break;
    case "map":
      for (const [key, value] of node.entries) {
        visit(key);
        visit(value);
      }
      for (const [, value] of node.properties) visit(value);
      break;
    case "set":
      for (const value of node.values) visit(value);
      for (const [, value] of node.properties) visit(value);
      break;
  }
}

function validateReachability(root: EncodedValue, nodes: EncodedNode[]): void {
  const reached = new Uint8Array(nodes.length);
  const stack: number[] = [];
  if (isReferenceToken(root)) stack.push(root.$ref);

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reached[id] === 1) continue;
    reached[id] = 1;
    const node = nodes[id];
    if (node === undefined) {
      throw new JSONPlusError("INVALID_REFERENCE", "Reference points to a nonexistent node.");
    }
    visitNodeValues(node, (value) => {
      if (isReferenceToken(value)) stack.push(value.$ref);
    });
  }

  for (let id = 0; id < reached.length; id += 1) {
    if (reached[id] !== 1) {
      throw new JSONPlusError(
        "UNREACHABLE_NODE",
        `Node ${id} is not reachable from the root value.`,
      );
    }
  }
}

function validateDocument(raw: unknown, limits: ResolvedLimits): Envelope {
  assertRecord(raw, "Envelope");
  assertEnvelopeKeys(raw);
  if (raw["format"] !== FORMAT) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Unrecognized JSON+ format identifier.");
  }
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Version must be a positive integer.");
  }
  if (version !== VERSION) {
    throw new JSONPlusError("UNSUPPORTED_VERSION", `JSON+ version ${version} is not supported.`);
  }
  if (!Array.isArray(raw["nodes"])) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Envelope nodes must be an array.");
  }
  if (raw["nodes"].length > limits.maxNodes) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Node count exceeds maxNodes (${limits.maxNodes}).`,
    );
  }

  const context: ValidationContext = {
    limits,
    nodeCount: raw["nodes"].length,
    edges: 0,
    binaryBytes: 0,
  };
  validateValue(raw["root"], context, false);
  const nodes = raw["nodes"].map((candidate) => validateNode(candidate, context));
  validateBufferViews(nodes);
  validateReachability(raw["root"] as EncodedValue, nodes);

  return { format: FORMAT, version: VERSION, root: raw["root"] as EncodedValue, nodes };
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

function allocateGraph(nodes: EncodedNode[]): unknown[] {
  const allocated: unknown[] = new Array(nodes.length);

  for (let id = 0; id < nodes.length; id += 1) {
    const node = nodes[id];
    if (node?.type !== "array-buffer") continue;
    try {
      allocated[id] = decodeBase64(node.bytes);
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
        const descriptor = TYPED_ARRAYS.find((item) => item.name === node.constructor);
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

function defineProperties(
  target: object,
  properties: EncodedProperty[],
  allocated: unknown[],
): void {
  for (const [key, value] of properties) {
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
        for (const [index, value] of node.entries) {
          Object.defineProperty(target, String(index), {
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
        for (const [encodedKey, encodedValue] of node.entries) {
          const key = resolveValue(encodedKey, allocated);
          if (map.has(key)) {
            throw new JSONPlusError("INVALID_NODE", "Map node contains duplicate keys.");
          }
          map.set(key, resolveValue(encodedValue, allocated));
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
  const envelope = validateDocument(parsed, limits);
  const allocated = allocateGraph(envelope.nodes);
  populateGraph(envelope.nodes, allocated);
  return resolveValue(envelope.root, allocated);
}
