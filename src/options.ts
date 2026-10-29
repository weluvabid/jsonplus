import { JSONPlusError } from "./errors.js";
import type { JSONPlusOptions, ResolvedLimits } from "./internal-types.js";

const DEFAULT_LIMITS: ResolvedLimits = {
  maxNodes: 1_000_000,
  maxEdges: 5_000_000,
  maxBinaryBytes: 32 * 1024 * 1024,
  maxStringLength: 16 * 1024 * 1024,
  maxCollectionEntries: 1_000_000,
  maxInputChars: 64 * 1024 * 1024,
  maxOutputChars: 64 * 1024 * 1024,
};

const OPTION_NAMES = new Set<keyof ResolvedLimits>([
  "maxNodes",
  "maxEdges",
  "maxBinaryBytes",
  "maxStringLength",
  "maxCollectionEntries",
  "maxInputChars",
  "maxOutputChars",
]);

export function resolveLimits(options?: JSONPlusOptions): ResolvedLimits {
  if (options === undefined) return { ...DEFAULT_LIMITS };

  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new JSONPlusError("INVALID_OPTIONS", "Options must be a plain object.");
  }

  const prototype = Object.getPrototypeOf(options) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JSONPlusError("INVALID_OPTIONS", "Options must be a plain object.");
  }

  for (const key of Object.keys(options)) {
    if (!OPTION_NAMES.has(key as keyof ResolvedLimits)) {
      throw new JSONPlusError("INVALID_OPTIONS", `Unknown option: ${key}.`);
    }
  }

  const result: ResolvedLimits = { ...DEFAULT_LIMITS };
  for (const name of OPTION_NAMES) {
    const value = options[name as keyof JSONPlusOptions];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new JSONPlusError(
        "INVALID_OPTIONS",
        `Option ${name} must be a non-negative safe integer.`,
      );
    }
    result[name] = value;
  }

  return result;
}

export function checkString(value: string, limits: ResolvedLimits, context = "string"): void {
  if (value.length > limits.maxStringLength) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `${context} exceeds maxStringLength (${limits.maxStringLength}).`,
    );
  }
}

export function checkCollectionLength(
  length: number,
  limits: ResolvedLimits,
  context: string,
): void {
  if (length > limits.maxCollectionEntries) {
    throw new JSONPlusError(
      "RESOURCE_LIMIT_EXCEEDED",
      `${context} exceeds maxCollectionEntries (${limits.maxCollectionEntries}).`,
    );
  }
}
