import { JSONPlusError } from "./errors.js";
import type { JSONPlusOptions } from "./internal-types.js";
import { resolveLimits } from "./options.js";
import { assertNoDuplicateObjectKeys } from "./decode/lexical.js";
import { validateDocument } from "./decode/document-validation.js";
import { allocateGraph, populateGraph, resolveValue } from "./decode/reconstruction.js";

/** Decode a JSON+ document into a new graph, preserving supported values and identity. */
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
