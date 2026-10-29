/** Validates node-specific schemas, binary views, and graph reachability. */

import { base64EncodedByteLength } from "../base64.js";
import { TYPED_ARRAY_BY_NAME } from "../builtins.js";
import { JSONPlusError } from "../errors.js";
import type { EncodedNode, EncodedValue } from "../internal-types.js";
import { checkCollectionLength, checkString } from "../options.js";
import {
  assertExactKeys,
  assertRecord,
  assertSafeInteger,
  isCanonicalNumericIndexString,
  isReferenceToken,
  type ValidationContext,
  validateProperties,
  validateReferenceSlot,
  validateValue,
} from "./validation-primitives.js";

const MAX_DATE_TIME = 8.64e15;
const REGEXP_FLAG_ORDER = "dgimsuvy";

export function validateNode(candidate: unknown, context: ValidationContext): EncodedNode {
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

export function validateBufferViews(
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

export function validateReachability(root: EncodedValue, nodes: EncodedNode[]): void {
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
