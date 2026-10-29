/** Shared low-level validators for primitive tags, references, and node properties. */

import { JSONPlusError } from "../errors.js";
import type { EncodedNode, EncodedValue, ResolvedLimits } from "../internal-types.js";
import { checkCollectionLength, checkString } from "../options.js";

const CANONICAL_BIGINT = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;

export interface ValidationContext {
  limits: ResolvedLimits;
  nodeCount: number;
  edges: number;
  binaryBytes: number;
  binaryByteLengths: WeakMap<EncodedNode, number>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReferenceToken(value: unknown): value is { $ref: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "$ref") &&
    typeof (value as { $ref?: unknown }).$ref === "number"
  );
}

export function assertRecord(
  value: unknown,
  context: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new JSONPlusError("INVALID_NODE", `${context} must be an object.`);
  }
}

export function assertExactKeys(
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

export function assertSafeInteger(
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new JSONPlusError("INVALID_NODE", `${context} must be a valid non-negative integer.`);
  }
  return value;
}

export function readReference(value: unknown, context: string, nodeCount: number): number {
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

export function validateValue(value: unknown, context: ValidationContext, isEdge: boolean): void {
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

export function validateReferenceSlot(
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

export function validateProperties(
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

export function isCanonicalNumericIndexString(key: string): boolean {
  if (key === "-0") return true;
  return String(Number(key)) === key;
}
