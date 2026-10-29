import { Buffer } from "node:buffer";
import { JSONPlusError } from "./errors.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE[ALPHABET.charCodeAt(index)] = index;
}

/** Return the decoded size from the encoded shape without scanning the payload. */
export function base64EncodedByteLength(value: string): number {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload length must be divisible by four.");
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Validate strict canonical standard base64 and return its decoded byte length. */
export function base64ByteLength(value: string): number {
  const byteLength = base64EncodedByteLength(value);
  if (value.length === 0) return 0;

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const decoded = code < DECODE.length ? DECODE[code] : undefined;
    if (decoded === undefined || decoded < 0) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload contains an invalid character.");
    }
  }

  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload has invalid padding.");
    }
  }

  if (padding === 2) {
    const penultimate = DECODE[value.charCodeAt(value.length - 3)];
    if (penultimate === undefined || penultimate < 0 || (penultimate & 15) !== 0) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload is not canonical.");
    }
  } else if (padding === 1) {
    const finalContent = DECODE[value.charCodeAt(value.length - 2)];
    if (finalContent === undefined || finalContent < 0 || (finalContent & 3) !== 0) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload is not canonical.");
    }
  }

  return byteLength;
}

/** Encode an ArrayBuffer using Node's native base64 implementation. */
export function encodeBase64(buffer: ArrayBuffer): string {
  try {
    return Buffer.from(buffer).toString("base64");
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "Detached ArrayBuffers cannot be encoded.", {
      cause,
    });
  }
}

/** Decode canonical base64 into a standalone ArrayBuffer. */
export function decodeBase64(value: string, expectedByteLength?: number): ArrayBuffer {
  const byteLength = base64ByteLength(value);
  if (expectedByteLength !== undefined && byteLength !== expectedByteLength) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload length does not match its metadata.");
  }

  let decoded: Buffer;
  try {
    // Buffer's decoder is lenient by design. The strict canonical check above is part of
    // JSON+'s wire contract and must run before passing bytes to the native decoder.
    decoded = Buffer.from(value, "base64");
  } catch (cause) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload could not be decoded.", { cause });
  }

  const backing = decoded.buffer;
  if (
    backing instanceof ArrayBuffer &&
    decoded.byteOffset === 0 &&
    decoded.byteLength === backing.byteLength
  ) {
    return backing;
  }
  return backing.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
}
