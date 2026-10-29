/** Validates the envelope and document-wide invariants without copying parsed data. */

import { JSONPlusError } from "../errors.js";
import type { EncodedNode, EncodedValue, ResolvedLimits } from "../internal-types.js";
import { FORMAT, VERSION } from "../internal-types.js";
import { validateBufferViews, validateNode, validateReachability } from "./node-validation.js";
import { isRecord, type ValidationContext, validateValue } from "./validation-primitives.js";

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

export interface ValidatedDocument {
  root: EncodedValue;
  nodes: EncodedNode[];
  binaryByteLengths: WeakMap<EncodedNode, number>;
}

export function validateDocument(raw: unknown, limits: ResolvedLimits): ValidatedDocument {
  if (!isRecord(raw)) {
    throw new JSONPlusError("INVALID_ENVELOPE", "Envelope must be an object.");
  }
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
