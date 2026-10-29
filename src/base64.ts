import { JSONPlusError } from "./errors.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE[ALPHABET.charCodeAt(index)] = index;
}

export function base64ByteLength(value: string): number {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload length must be divisible by four.");
  }

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

  const penultimate = DECODE[value.charCodeAt(value.length - 3)];
  const finalContent = DECODE[value.charCodeAt(value.length - 2)];
  if (padding === 2 && penultimate !== undefined && (penultimate & 15) !== 0) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload is not canonical.");
  }
  if (padding === 1 && finalContent !== undefined && (finalContent & 3) !== 0) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload is not canonical.");
  }

  return (value.length / 4) * 3 - padding;
}

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

export function decodeBase64(value: string): ArrayBuffer {
  const byteLength = base64ByteLength(value);
  const buffer = new ArrayBuffer(byteLength);
  const output = new Uint8Array(buffer);
  let target = 0;

  for (let source = 0; source < value.length; source += 4) {
    const first = DECODE[value.charCodeAt(source)] ?? -1;
    const second = DECODE[value.charCodeAt(source + 1)] ?? -1;
    const thirdChar = value.charCodeAt(source + 2);
    const fourthChar = value.charCodeAt(source + 3);
    const third = thirdChar === 61 ? 0 : (DECODE[thirdChar] ?? -1);
    const fourth = fourthChar === 61 ? 0 : (DECODE[fourthChar] ?? -1);

    output[target] = (first << 2) | (second >>> 4);
    target += 1;
    if (target < byteLength) {
      output[target] = ((second & 15) << 4) | (third >>> 2);
      target += 1;
    }
    if (target < byteLength) {
      output[target] = ((third & 3) << 6) | fourth;
      target += 1;
    }
  }

  return buffer;
}
