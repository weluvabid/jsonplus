import { JSONPlusError } from "./errors.js";

export type ReferenceKind =
  | "object"
  | "array"
  | "date"
  | "regexp"
  | "map"
  | "set"
  | "array-buffer"
  | "typed-array"
  | "data-view";

export interface TypedArrayDescriptor {
  readonly name: string;
  readonly prototype: object;
  readonly bytesPerElement: number;
  create(buffer: ArrayBuffer, byteOffset: number, length: number): object;
}

export const TYPED_ARRAYS: readonly TypedArrayDescriptor[] = [
  {
    name: "Int8Array",
    prototype: Int8Array.prototype,
    bytesPerElement: Int8Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Int8Array(buffer, offset, length),
  },
  {
    name: "Uint8Array",
    prototype: Uint8Array.prototype,
    bytesPerElement: Uint8Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Uint8Array(buffer, offset, length),
  },
  {
    name: "Uint8ClampedArray",
    prototype: Uint8ClampedArray.prototype,
    bytesPerElement: Uint8ClampedArray.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Uint8ClampedArray(buffer, offset, length),
  },
  {
    name: "Int16Array",
    prototype: Int16Array.prototype,
    bytesPerElement: Int16Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Int16Array(buffer, offset, length),
  },
  {
    name: "Uint16Array",
    prototype: Uint16Array.prototype,
    bytesPerElement: Uint16Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Uint16Array(buffer, offset, length),
  },
  {
    name: "Int32Array",
    prototype: Int32Array.prototype,
    bytesPerElement: Int32Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Int32Array(buffer, offset, length),
  },
  {
    name: "Uint32Array",
    prototype: Uint32Array.prototype,
    bytesPerElement: Uint32Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Uint32Array(buffer, offset, length),
  },
  {
    name: "Float32Array",
    prototype: Float32Array.prototype,
    bytesPerElement: Float32Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Float32Array(buffer, offset, length),
  },
  {
    name: "Float64Array",
    prototype: Float64Array.prototype,
    bytesPerElement: Float64Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new Float64Array(buffer, offset, length),
  },
  {
    name: "BigInt64Array",
    prototype: BigInt64Array.prototype,
    bytesPerElement: BigInt64Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new BigInt64Array(buffer, offset, length),
  },
  {
    name: "BigUint64Array",
    prototype: BigUint64Array.prototype,
    bytesPerElement: BigUint64Array.BYTES_PER_ELEMENT,
    create: (buffer, offset, length) => new BigUint64Array(buffer, offset, length),
  },
];

export function classifyReference(value: object): {
  kind: ReferenceKind;
  prototype: "object" | "null" | null;
  typedArray?: TypedArrayDescriptor;
} {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The object's prototype could not be inspected.", {
      cause,
    });
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new JSONPlusError(
        "UNSUPPORTED_TYPE",
        "Array subclasses and custom array prototypes are unsupported.",
      );
    }
    return { kind: "array", prototype: null };
  }

  if (prototype === Object.prototype) return { kind: "object", prototype: "object" };
  if (prototype === null) return { kind: "object", prototype: "null" };
  if (prototype === Date.prototype) return { kind: "date", prototype: null };
  if (prototype === RegExp.prototype) return { kind: "regexp", prototype: null };
  if (prototype === Map.prototype) return { kind: "map", prototype: null };
  if (prototype === Set.prototype) return { kind: "set", prototype: null };
  if (prototype === ArrayBuffer.prototype) return { kind: "array-buffer", prototype: null };
  if (prototype === DataView.prototype) return { kind: "data-view", prototype: null };

  const typedArray = TYPED_ARRAYS.find((item) => item.prototype === prototype);
  if (typedArray !== undefined) {
    return { kind: "typed-array", prototype: null, typedArray };
  }

  const sharedArrayBufferPrototype =
    typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer.prototype;
  if (sharedArrayBufferPrototype !== undefined && prototype === sharedArrayBufferPrototype) {
    throw new JSONPlusError(
      "UNSUPPORTED_TYPE",
      "SharedArrayBuffer is unsupported in JSON+ version 1.",
    );
  }

  throw new JSONPlusError(
    "UNSUPPORTED_TYPE",
    "Only plain objects, arrays, supported built-ins, and their documented state are supported.",
  );
}

export function readDateTime(value: object): number {
  try {
    return Date.prototype.getTime.call(value);
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The Date object could not be inspected.", {
      cause,
    });
  }
}

export function readRegExpSource(value: object): string {
  const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
  if (getter === undefined) {
    throw new JSONPlusError(
      "UNSUPPORTED_TYPE",
      "This runtime does not expose the RegExp source getter.",
    );
  }
  try {
    return Reflect.apply(getter, value, []) as string;
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The RegExp object could not be inspected.", {
      cause,
    });
  }
}

export function readRegExpFlags(value: object): string {
  const flagGetters: readonly [string, string][] = [
    ["hasIndices", "d"],
    ["global", "g"],
    ["ignoreCase", "i"],
    ["multiline", "m"],
    ["dotAll", "s"],
    ["unicode", "u"],
    ["unicodeSets", "v"],
    ["sticky", "y"],
  ];
  let flags = "";

  for (const [name, flag] of flagGetters) {
    const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, name)?.get;
    if (getter === undefined) continue;
    try {
      if (Reflect.apply(getter, value, []) === true) flags += flag;
    } catch (cause) {
      throw new JSONPlusError("UNSUPPORTED_TYPE", "The RegExp flags could not be inspected.", {
        cause,
      });
    }
  }

  return flags;
}

export function readTypedArrayState(value: object): {
  buffer: ArrayBuffer;
  byteOffset: number;
  length: number;
} {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
  const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
  const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;

  if (bufferGetter === undefined || offsetGetter === undefined || lengthGetter === undefined) {
    throw new JSONPlusError(
      "UNSUPPORTED_TYPE",
      "This runtime does not expose typed-array intrinsics.",
    );
  }

  try {
    return {
      buffer: Reflect.apply(bufferGetter, value, []) as ArrayBuffer,
      byteOffset: Reflect.apply(offsetGetter, value, []) as number,
      length: Reflect.apply(lengthGetter, value, []) as number,
    };
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The typed array could not be inspected.", {
      cause,
    });
  }
}

export function readDataViewState(value: object): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
} {
  const bufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get;
  const offsetGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")?.get;
  const lengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;

  if (bufferGetter === undefined || offsetGetter === undefined || lengthGetter === undefined) {
    throw new JSONPlusError(
      "UNSUPPORTED_TYPE",
      "This runtime does not expose DataView intrinsics.",
    );
  }

  try {
    return {
      buffer: Reflect.apply(bufferGetter, value, []) as ArrayBuffer,
      byteOffset: Reflect.apply(offsetGetter, value, []) as number,
      byteLength: Reflect.apply(lengthGetter, value, []) as number,
    };
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The DataView could not be inspected.", {
      cause,
    });
  }
}

export function readArrayBufferByteLength(value: object): number {
  const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
  if (getter === undefined) {
    throw new JSONPlusError(
      "UNSUPPORTED_TYPE",
      "This runtime does not expose ArrayBuffer intrinsics.",
    );
  }
  try {
    return Reflect.apply(getter, value, []) as number;
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The ArrayBuffer could not be inspected.", {
      cause,
    });
  }
}

export function isResizableArrayBuffer(value: object): boolean {
  const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
  if (getter === undefined) return false;
  try {
    return Reflect.apply(getter, value, []) === true;
  } catch (cause) {
    throw new JSONPlusError("UNSUPPORTED_TYPE", "The ArrayBuffer could not be inspected.", {
      cause,
    });
  }
}
