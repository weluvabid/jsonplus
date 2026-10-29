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

type ViewNode = Extract<EncodedNode, { type: "typed-array" | "data-view" }>;

function allocateView(id: number, node: ViewNode, allocated: unknown[]): void {
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

export function allocateGraph(
  nodes: EncodedNode[],
  binaryByteLengths: WeakMap<EncodedNode, number>,
): unknown[] {
  const allocated: unknown[] = new Array(nodes.length);
  const deferredViews = new Map<number, number[]>();

  for (let id = 0; id < nodes.length; id += 1) {
    const node = nodes[id];
    if (node === undefined) continue;

    if (node.type === "array-buffer") {
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

      const waiting = deferredViews.get(id);
      if (waiting !== undefined) {
        for (const viewId of waiting) {
          const viewNode = nodes[viewId];
          if (
            viewNode === undefined ||
            (viewNode.type !== "typed-array" && viewNode.type !== "data-view")
          ) {
            throw new JSONPlusError("INVALID_NODE", `Deferred view node ${viewId} is invalid.`);
          }
          allocateView(viewId, viewNode, allocated);
        }
        deferredViews.delete(id);
      }
      continue;
    }

    if (node.type === "typed-array" || node.type === "data-view") {
      const bufferId = node.buffer.$ref;
      if (allocated[bufferId] instanceof ArrayBuffer) {
        allocateView(id, node, allocated);
      } else if (bufferId > id && nodes[bufferId]?.type === "array-buffer") {
        const waiting = deferredViews.get(bufferId);
        if (waiting === undefined) {
          deferredViews.set(bufferId, [id]);
        } else {
          waiting.push(id);
        }
      } else {
        throw new JSONPlusError(
          "INVALID_REFERENCE",
          `Node ${id} does not reference an allocated ArrayBuffer.`,
        );
      }
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

  if (deferredViews.size !== 0) {
    throw new JSONPlusError("INVALID_REFERENCE", "One or more view buffers were not allocated.");
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
