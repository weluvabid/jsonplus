/** Lexical checks over raw JSON text that JSON.parse cannot report, including duplicate keys. */

import { JSONPlusError } from "../errors.js";

type JSONContainer = { kind: "object"; keys: Set<string> } | { kind: "array" };

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return 0;
}

function decodeJSONStringToken(
  input: string,
  start: number,
  end: number,
  firstEscape: number,
): string {
  const contentStart = start + 1;
  const contentEnd = end - 1;
  if (firstEscape < 0 || firstEscape >= contentEnd) {
    return input.slice(contentStart, contentEnd);
  }

  const parts: string[] = [];
  let segmentStart = contentStart;
  for (let index = firstEscape; index < contentEnd; ) {
    if (input.charCodeAt(index) !== 92) {
      index += 1;
      continue;
    }

    parts.push(input.slice(segmentStart, index));
    const escaped = input.charCodeAt(index + 1);
    switch (escaped) {
      case 34:
        parts.push('"');
        index += 2;
        break;
      case 92:
        parts.push("\\");
        index += 2;
        break;
      case 47:
        parts.push("/");
        index += 2;
        break;
      case 98:
        parts.push("\b");
        index += 2;
        break;
      case 102:
        parts.push("\f");
        index += 2;
        break;
      case 110:
        parts.push("\n");
        index += 2;
        break;
      case 114:
        parts.push("\r");
        index += 2;
        break;
      case 116:
        parts.push("\t");
        index += 2;
        break;
      case 117: {
        const code =
          (hexDigit(input.charCodeAt(index + 2)) << 12) |
          (hexDigit(input.charCodeAt(index + 3)) << 8) |
          (hexDigit(input.charCodeAt(index + 4)) << 4) |
          hexDigit(input.charCodeAt(index + 5));
        parts.push(String.fromCharCode(code));
        index += 6;
        break;
      }
      default:
        index += 2;
        break;
    }
    segmentStart = index;
  }
  parts.push(input.slice(segmentStart, contentEnd));
  return parts.join("");
}

export function assertNoDuplicateObjectKeys(input: string): void {
  const containers: JSONContainer[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "{") {
      containers.push({ kind: "object", keys: new Set<string>() });
      continue;
    }
    if (character === "[") {
      containers.push({ kind: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    let escaped = false;
    let firstEscape = -1;
    for (index += 1; index < input.length; index += 1) {
      const current = input[index];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        if (firstEscape < 0) firstEscape = index;
        escaped = true;
      } else if (current === '"') {
        break;
      }
    }

    const end = index + 1;
    let next = end;
    while (next < input.length) {
      const code = input.charCodeAt(next);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      next += 1;
    }

    if (input[next] === ":") {
      const container = containers[containers.length - 1];
      if (container?.kind !== "object") {
        throw new JSONPlusError("INVALID_INPUT", "Object key appears outside an object.");
      }

      const key = decodeJSONStringToken(input, start, end, firstEscape);
      if (container.keys.has(key)) {
        throw new JSONPlusError(
          "INVALID_INPUT",
          `Duplicate JSON object member ${JSON.stringify(key)} is not allowed.`,
        );
      }
      container.keys.add(key);
    }

    index = end - 1;
  }
}
