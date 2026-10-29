import { JSONPlusError } from "./errors.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE[ALPHABET.charCodeAt(index)] = index;
}

export function base64EncodedByteLength(value: string): number {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload length must be divisible by four.");
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

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

type GlobalWithBtoa = typeof globalThis & { btoa?: (value: string) => string };

export function encodeBase64(buffer: ArrayBuffer): string {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(buffer);
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "Detached ArrayBuffers cannot be encoded.", {
      cause,
    });
  }

  if (bytes.byteLength === 0) return "";

  const nativeBtoa = (globalThis as GlobalWithBtoa).btoa;
  if (typeof nativeBtoa === "function") {
    // The chunk size is divisible by three, so only the final chunk can contain padding.
    // Native base64 conversion is substantially faster than encoding every quartet in JS.
    const chunkSize = 12 * 1024;
    const chunks: string[] = [];
    for (let start = 0; start < bytes.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, bytes.length);
      chunks.push(nativeBtoa.call(globalThis, String.fromCharCode(...bytes.subarray(start, end))));
    }
    return chunks.join("");
  }

  const chunkSize = 12 * 1024;
  const chunks: string[] = [];

  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, bytes.length);
    const output = new Uint8Array(Math.ceil((end - start) / 3) * 4);
    let source = start;
    let target = 0;

    while (source < end) {
      const first = bytes[source] ?? 0;
      const hasSecond = source + 1 < end;
      const hasThird = source + 2 < end;
      const second = hasSecond ? (bytes[source + 1] ?? 0) : 0;
      const third = hasThird ? (bytes[source + 2] ?? 0) : 0;

      output[target] = ALPHABET.charCodeAt(first >>> 2);
      output[target + 1] = ALPHABET.charCodeAt(((first & 3) << 4) | (second >>> 4));
      output[target + 2] = hasSecond
        ? ALPHABET.charCodeAt(((second & 15) << 2) | (third >>> 6))
        : 61;
      output[target + 3] = hasThird ? ALPHABET.charCodeAt(third & 63) : 61;

      source += 3;
      target += 4;
    }

    chunks.push(String.fromCharCode(...output));
  }

  return chunks.join("");
}

export function decodeBase64(value: string, expectedByteLength?: number): ArrayBuffer {
  const byteLength = expectedByteLength ?? base64EncodedByteLength(value);
  if (byteLength !== base64EncodedByteLength(value)) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload length does not match its metadata.");
  }

  const buffer = new ArrayBuffer(byteLength);
  const output = new Uint8Array(buffer);
  let target = 0;

  for (let source = 0; source < value.length; source += 4) {
    const firstCode = value.charCodeAt(source);
    const secondCode = value.charCodeAt(source + 1);
    const thirdCode = value.charCodeAt(source + 2);
    const fourthCode = value.charCodeAt(source + 3);
    const first = (firstCode < DECODE.length ? DECODE[firstCode] : -1) ?? -1;
    const second = (secondCode < DECODE.length ? DECODE[secondCode] : -1) ?? -1;
    const third =
      (thirdCode === 61 ? -1 : thirdCode < DECODE.length ? DECODE[thirdCode] : -1) ?? -1;
    const fourth =
      (fourthCode === 61 ? -1 : fourthCode < DECODE.length ? DECODE[fourthCode] : -1) ?? -1;
    const finalChunk = source + 4 === value.length;

    if (first < 0 || second < 0) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload contains an invalid character.");
    }
    if (thirdCode === 61) {
      if (!finalChunk || fourthCode !== 61 || (second & 15) !== 0) {
        throw new JSONPlusError("INVALID_BINARY", "Base64 payload has invalid padding.");
      }
    } else if (third < 0) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload contains an invalid character.");
    }
    if (fourthCode === 61) {
      if (!finalChunk || (thirdCode !== 61 && (third & 3) !== 0)) {
        throw new JSONPlusError("INVALID_BINARY", "Base64 payload has invalid padding.");
      }
    } else if (fourth < 0) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload contains an invalid character.");
    }
    if (!finalChunk && (thirdCode === 61 || fourthCode === 61)) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload has invalid padding.");
    }

    output[target] = (first << 2) | (second >>> 4);
    target += 1;
    if (thirdCode !== 61 && target < byteLength) {
      output[target] = ((second & 15) << 4) | (third >>> 2);
      target += 1;
    }
    if (fourthCode !== 61 && target < byteLength) {
      output[target] = ((third & 3) << 6) | fourth;
      target += 1;
    }
  }

  return buffer;
}
