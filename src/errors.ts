export type JSONPlusErrorCode =
  | "INVALID_OPTIONS"
  | "UNSUPPORTED_TYPE"
  | "UNSUPPORTED_PROPERTY"
  | "INVALID_INPUT"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_VERSION"
  | "INVALID_TAG"
  | "INVALID_REFERENCE"
  | "INVALID_NODE"
  | "INVALID_BINARY"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "UNREACHABLE_NODE";

export class JSONPlusError extends TypeError {
  readonly code: JSONPlusErrorCode;

  constructor(code: JSONPlusErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JSONPlusError";
    this.code = code;
  }
}
