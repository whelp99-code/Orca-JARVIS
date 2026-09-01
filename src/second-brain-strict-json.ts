export const SECOND_BRAIN_STRICT_JSON_MAX_DEPTH = 64;
export const SECOND_BRAIN_STRICT_JSON_MAX_NODES = 4_096;
export const SECOND_BRAIN_STRICT_JSON_MAX_WORK_ITEMS = 16_384;
export const SECOND_BRAIN_STRICT_JSON_MAX_CHARACTERS = 1_048_576;

class StrictJsonError extends Error {
  readonly name = "StrictJsonError";
}

class StrictJsonReader {
  private index = 0;
  private nodes = 0;
  private workItems = 0;

  constructor(private readonly text: string) {}

  read(): unknown {
    if (this.text.length > SECOND_BRAIN_STRICT_JSON_MAX_CHARACTERS) throw new StrictJsonError();
    this.whitespace();
    this.value(0);
    this.whitespace();
    if (this.index !== this.text.length) throw new StrictJsonError();
    return immutableJsonValue(JSON.parse(this.text));
  }

  private value(depth: number): void {
    this.nodes += 1;
    this.workItems += 1;
    if (depth > SECOND_BRAIN_STRICT_JSON_MAX_DEPTH || this.nodes > SECOND_BRAIN_STRICT_JSON_MAX_NODES
      || this.workItems > SECOND_BRAIN_STRICT_JSON_MAX_WORK_ITEMS) throw new StrictJsonError();
    switch (this.text[this.index]) {
      case "{": this.object(depth); return;
      case "[": this.array(depth); return;
      case "\"": this.string(); return;
      case "t": this.literal("true"); return;
      case "f": this.literal("false"); return;
      case "n": this.literal("null"); return;
      default: this.number();
    }
  }

  private object(depth: number): void {
    this.index += 1;
    this.whitespace();
    if (this.consume("}")) return;
    const keys = new Set<string>();
    for (;;) {
      if (this.text[this.index] !== "\"") throw new StrictJsonError();
      const key = this.string();
      this.workItems += 1;
      if (this.workItems > SECOND_BRAIN_STRICT_JSON_MAX_WORK_ITEMS || keys.has(key)) throw new StrictJsonError();
      keys.add(key);
      this.whitespace();
      if (!this.consume(":")) throw new StrictJsonError();
      this.whitespace();
      this.value(depth + 1);
      this.whitespace();
      if (this.consume("}")) return;
      if (!this.consume(",")) throw new StrictJsonError();
      this.whitespace();
    }
  }

  private array(depth: number): void {
    this.index += 1;
    this.whitespace();
    if (this.consume("]")) return;
    for (;;) {
      this.value(depth + 1);
      this.whitespace();
      if (this.consume("]")) return;
      if (!this.consume(",")) throw new StrictJsonError();
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const decoded: unknown = JSON.parse(this.text.slice(start, this.index));
        if (typeof decoded !== "string") throw new StrictJsonError();
        return decoded;
      }
      if (code < 0x20) throw new StrictJsonError();
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            const digit = this.text[this.index + offset];
            if (digit === undefined || !/[0-9a-fA-F]/.test(digit)) throw new StrictJsonError();
          }
          this.index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) throw new StrictJsonError();
      }
      this.index += 1;
    }
    throw new StrictJsonError();
  }

  private number(): void {
    const start = this.index;
    if (this.consume("-")) {
      const next = this.text[this.index];
      if (next === undefined || next < "0" || next > "9") throw new StrictJsonError();
    }
    if (this.consume("0")) {
      const next = this.text[this.index];
      if (next !== undefined && next >= "0" && next <= "9") throw new StrictJsonError();
    } else {
      this.digits(true);
    }
    if (this.consume(".")) this.digits(true);
    const exponent = this.text[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      this.digits(true);
    }
    if (!Number.isFinite(Number(this.text.slice(start, this.index)))) throw new StrictJsonError();
  }

  private digits(required: boolean): void {
    const start = this.index;
    for (;;) {
      const digit = this.text[this.index];
      if (digit === undefined || digit < "0" || digit > "9") break;
      this.index += 1;
    }
    if (required && start === this.index) throw new StrictJsonError();
  }

  private literal(expected: string): void {
    if (!this.text.startsWith(expected, this.index)) throw new StrictJsonError();
    this.index += expected.length;
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private whitespace(): void {
    while (this.text[this.index] === " " || this.text[this.index] === "\n"
      || this.text[this.index] === "\r" || this.text[this.index] === "\t") this.index += 1;
  }
}

function immutableJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    // Escaped controls and non-NFC text are legal JSON content; only an unpaired
    // surrogate is unrepresentable in UTF-8 and must be refused here.
    if (hasLoneSurrogate(value)) throw new StrictJsonError();
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJsonValue));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new StrictJsonError();
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsedKey = immutableJsonValue(key);
    if (typeof parsedKey !== "string") throw new StrictJsonError();
    result[parsedKey] = immutableJsonValue(item);
  }
  return Object.freeze(result);
}


function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function parseSecondBrainStrictJson(text: string): unknown | undefined {
  try {
    return new StrictJsonReader(text).read();
  } catch (error) {
    if (error instanceof StrictJsonError || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function parseSecondBrainStrictJsonBytes(bytes: Uint8Array): unknown | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined;
  try {
    return parseSecondBrainStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
