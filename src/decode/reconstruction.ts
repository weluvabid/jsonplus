/** Allocates graph nodes first, then populates edges to preserve cycles and identity. */

import { decodeBase64 } from "../base64.js";
import { TYPED_ARRAY_BY_NAME } from "../builtins.js";
import { JSONPlusError } from "../errors.js";
import type { EncodedNode, EncodedValue } from "../internal-types.js";

export function resolveValue(value: EncodedValue, nodes: unknown[]): unknown {
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

export function allocateGraph(
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

export function populateGraph(nodes: EncodedNode[], allocated: unknown[]): void {
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
