import { JSONPlusError } from "./errors.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE[ALPHABET.charCodeAt(index)] = index;
}

// Multiples of three/four keep encoder/decoder chunks aligned at Base64 boundaries.
const BINARY_CHUNK_SIZE = 0x6000;
const BASE64_CHUNK_SIZE = 0x6000;

interface NativeBuffer extends Uint8Array {
  toString(encoding?: "base64"): string;
}

interface NativeBufferConstructor {
  from(buffer: ArrayBuffer): NativeBuffer;
  from(value: string, encoding: "base64"): NativeBuffer;
}

interface NodeProcessLike {
  release?: { name?: string };
}

interface RuntimeGlobals {
  Buffer?: NativeBufferConstructor;
  process?: NodeProcessLike;
  atob?: (value: string) => string;
  btoa?: (value: string) => string;
}

type Uint8ArrayWithBase64 = Uint8Array & { toBase64?: () => string };
type Uint8ArrayConstructorWithBase64 = typeof Uint8Array & {
  fromBase64?: (value: string) => Uint8Array;
};

// Node's global Buffer is the native constructor exported by node:buffer. Avoiding a static
// import keeps this shared module browser-resolvable.
function nodeBuffer(): NativeBufferConstructor | undefined {
  const runtime = globalThis as typeof globalThis & RuntimeGlobals;
  return runtime.process?.release?.name === "node" ? runtime.Buffer : undefined;
}

function encodeBrowserBase64(bytes: Uint8Array): string {
  const nativeEncode = (bytes as Uint8ArrayWithBase64).toBase64;
  if (typeof nativeEncode === "function") return nativeEncode.call(bytes);

  const btoa = (globalThis as RuntimeGlobals).btoa;
  if (typeof btoa !== "function") {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "This runtime does not support Base64 encoding.");
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    const binary = String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE));
    chunks.push(btoa.call(globalThis, binary));
  }
  return chunks.join("");
}

function standaloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const backing = bytes.buffer;
  if (!(backing instanceof ArrayBuffer)) {
    throw new JSONPlusError("INVALID_BINARY", "Decoded bytes do not use an ArrayBuffer.");
  }
  if (bytes.byteOffset === 0 && bytes.byteLength === backing.byteLength) return backing;
  return backing.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function decodeBrowserBase64(value: string, byteLength: number): ArrayBuffer {
  const nativeDecode = (Uint8Array as Uint8ArrayConstructorWithBase64).fromBase64;
  if (typeof nativeDecode === "function") {
    const bytes = nativeDecode.call(Uint8Array, value);
    if (bytes.byteLength !== byteLength) {
      throw new JSONPlusError("INVALID_BINARY", "Base64 payload decoded to an unexpected length.");
    }
    return standaloneArrayBuffer(bytes);
  }

  const atob = (globalThis as RuntimeGlobals).atob;
  if (typeof atob !== "function") {
    throw new JSONPlusError("INVALID_BINARY", "This runtime does not support Base64 decoding.");
  }

  const bytes = new Uint8Array(byteLength);
  let outputOffset = 0;
  for (let offset = 0; offset < value.length; offset += BASE64_CHUNK_SIZE) {
    const binary = atob.call(globalThis, value.slice(offset, offset + BASE64_CHUNK_SIZE));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[outputOffset] = binary.charCodeAt(index);
      outputOffset += 1;
    }
  }
  if (outputOffset !== byteLength) {
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload decoded to an unexpected length.");
  }
  return standaloneArrayBuffer(bytes);
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

/** Encode an ArrayBuffer using Node's native codec or browser byte APIs. */
export function encodeBase64(buffer: ArrayBuffer): string {
  const nativeBuffer = nodeBuffer();
  if (nativeBuffer !== undefined) {
    try {
      return nativeBuffer.from(buffer).toString("base64");
    } catch (cause) {
      throw new JSONPlusError("UNSUPPORTED_TYPE", "Detached ArrayBuffers cannot be encoded.", {
        cause,
      });
    }
  }

  try {
    return encodeBrowserBase64(new Uint8Array(buffer));
  } catch (cause) {
    if (cause instanceof JSONPlusError) throw cause;
    throw new JSONPlusError("UNSUPPORTED_TYPE", "ArrayBuffer bytes could not be encoded.", {
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

  const nativeBuffer = nodeBuffer();
  if (nativeBuffer !== undefined) {
    let decoded: NativeBuffer;
    try {
      // Buffer decoding is lenient by design; strict validation above defines JSON+'s wire rules.
      decoded = nativeBuffer.from(value, "base64");
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
    if (!(backing instanceof ArrayBuffer)) {
      throw new JSONPlusError("INVALID_BINARY", "Decoded bytes do not use an ArrayBuffer.");
    }
    return backing.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
  }

  try {
    return decodeBrowserBase64(value, byteLength);
  } catch (cause) {
    if (cause instanceof JSONPlusError) throw cause;
    throw new JSONPlusError("INVALID_BINARY", "Base64 payload could not be decoded.", { cause });
  }
}
