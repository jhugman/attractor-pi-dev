import type { SourceLocation } from "./ast.js";

export enum TokenType {
  // Keywords
  Digraph = "digraph",
  Subgraph = "subgraph",
  Graph = "graph",
  Node = "node",
  Edge = "edge",
  True = "true",
  False = "false",

  // Symbols
  LBrace = "{",
  RBrace = "}",
  LBracket = "[",
  RBracket = "]",
  Equals = "=",
  Arrow = "->",
  Comma = ",",
  Semicolon = ";",
  Dot = ".",

  // Literals
  Identifier = "identifier",
  String = "string",
  Integer = "integer",
  Float = "float",
  Duration = "duration",

  // Special
  EOF = "eof",
}

export interface Token {
  type: TokenType;
  value: string;
  loc: SourceLocation;
}

const KEYWORDS: Record<string, TokenType> = {
  digraph: TokenType.Digraph,
  subgraph: TokenType.Subgraph,
  graph: TokenType.Graph,
  node: TokenType.Node,
  edge: TokenType.Edge,
  true: TokenType.True,
  false: TokenType.False,
};

export class LexerError extends Error {
  constructor(
    message: string,
    public loc: SourceLocation,
  ) {
    super(`${message} at line ${loc.line}, column ${loc.column}`);
    this.name = "LexerError";
  }
}

export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;
  private tokens: Token[] = [];
  private source: string;

  constructor(source: string) {
    this.source = this.stripComments(source);
  }

  tokenize(): Token[] {
    this.tokens = [];
    this.pos = 0;
    this.line = 1;
    this.column = 1;

    while (this.pos < this.source.length) {
      this.skipWhitespace();
      if (this.pos >= this.source.length) break;

      const ch = this.source[this.pos]!;
      const loc = this.loc();

      if (ch === "{") {
        this.tokens.push({ type: TokenType.LBrace, value: "{", loc });
        this.advance();
      } else if (ch === "}") {
        this.tokens.push({ type: TokenType.RBrace, value: "}", loc });
        this.advance();
      } else if (ch === "[") {
        this.tokens.push({ type: TokenType.LBracket, value: "[", loc });
        this.advance();
      } else if (ch === "]") {
        this.tokens.push({ type: TokenType.RBracket, value: "]", loc });
        this.advance();
      } else if (ch === "=" && this.peek(1) !== ">") {
        this.tokens.push({ type: TokenType.Equals, value: "=", loc });
        this.advance();
      } else if (ch === "-" && this.peek(1) === ">") {
        this.tokens.push({ type: TokenType.Arrow, value: "->", loc });
        this.advance();
        this.advance();
      } else if (ch === ",") {
        this.tokens.push({ type: TokenType.Comma, value: ",", loc });
        this.advance();
      } else if (ch === ";") {
        this.tokens.push({ type: TokenType.Semicolon, value: ";", loc });
        this.advance();
      } else if (ch === ".") {
        this.tokens.push({ type: TokenType.Dot, value: ".", loc });
        this.advance();
      } else if (ch === '"') {
        this.tokens.push(this.readString());
      } else if (ch === "-" && this.isDigit(this.peek(1))) {
        this.tokens.push(this.readNumber());
      } else if (this.isDigit(ch)) {
        this.tokens.push(this.readNumber());
      } else if (this.isIdentStart(ch)) {
        this.tokens.push(this.readIdentOrKeyword());
      } else {
        throw new LexerError(`Unexpected character '${ch}'`, loc);
      }
    }

    this.tokens.push({ type: TokenType.EOF, value: "", loc: this.loc() });
    return this.tokens;
  }

  private stripComments(source: string): string {
    let result = "";
    let i = 0;
    while (i < source.length) {
      if (source[i] === '"') {
        // Skip through strings preserving them
        result += source[i]!;
        i++;
        while (i < source.length && source[i] !== '"') {
          if (source[i] === "\\") {
            result += source[i]!;
            i++;
            if (i < source.length) {
              result += source[i]!;
              i++;
            }
          } else {
            result += source[i]!;
            i++;
          }
        }
        if (i < source.length) {
          result += source[i]!; // closing quote
          i++;
        }
      } else if (source[i] === "/" && source[i + 1] === "/") {
        // Line comment: replace with spaces to preserve line numbers
        while (i < source.length && source[i] !== "\n") {
          result += " ";
          i++;
        }
      } else if (source[i] === "/" && source[i + 1] === "*") {
        // Block comment: replace with spaces/newlines to preserve positions
        i += 2;
        result += "  ";
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
          result += source[i] === "\n" ? "\n" : " ";
          i++;
        }
        if (i < source.length) {
          result += "  ";
          i += 2; // skip */
        }
      } else {
        result += source[i]!;
        i++;
      }
    }
    return result;
  }

  private readString(): Token {
    const loc = this.loc();
    this.advance(); // skip opening quote
    let value = "";
    while (this.pos < this.source.length && this.source[this.pos] !== '"') {
      if (this.source[this.pos] === "\\") {
        this.advance();
        const escaped = this.source[this.pos];
        if (escaped === "n") value += "\n";
        else if (escaped === "t") value += "\t";
        else if (escaped === "\\") value += "\\";
        else if (escaped === '"') value += '"';
        else value += escaped;
        this.advance();
      } else {
        value += this.source[this.pos];
        this.advance();
      }
    }
    if (this.pos >= this.source.length) {
      throw new LexerError("Unterminated string", loc);
    }
    this.advance(); // skip closing quote
    return { type: TokenType.String, value, loc };
  }

  private readNumber(): Token {
    const loc = this.loc();
    let value = "";
    if (this.source[this.pos] === "-") {
      value += "-";
      this.advance();
    }
    while (this.pos < this.source.length && this.isDigit(this.source[this.pos])) {
      value += this.source[this.pos];
      this.advance();
    }

    // Check for duration suffix
    const suffix = this.peekDurationSuffix();
    if (suffix) {
      for (let i = 0; i < suffix.length; i++) this.advance();
      return {
        type: TokenType.Duration,
        value: value + suffix,
        loc,
      };
    }

    // Check for float
    if (this.source[this.pos] === "." && this.isDigit(this.peek(1))) {
      value += ".";
      this.advance();
      while (this.pos < this.source.length && this.isDigit(this.source[this.pos])) {
        value += this.source[this.pos];
        this.advance();
      }
      return { type: TokenType.Float, value, loc };
    }

    return { type: TokenType.Integer, value, loc };
  }

  private peekDurationSuffix(): string | null {
    const rest = this.source.slice(this.pos);
    const match = rest.match(/^(ms|s|m|h|d)(?![A-Za-z0-9_])/);
    return match ? match[1]! : null;
  }

  private readIdentOrKeyword(): Token {
    const loc = this.loc();
    let value = "";
    while (
      this.pos < this.source.length &&
      this.isIdentChar(this.source[this.pos])
    ) {
      value += this.source[this.pos];
      this.advance();
    }
    const kwType = KEYWORDS[value];
    if (kwType !== undefined) {
      return { type: kwType, value, loc };
    }
    return { type: TokenType.Identifier, value, loc };
  }

  private advance(): void {
    if (this.pos < this.source.length) {
      if (this.source[this.pos] === "\n") {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.pos++;
    }
  }

  private peek(offset: number): string | undefined {
    return this.source[this.pos + offset];
  }

  private skipWhitespace(): void {
    while (
      this.pos < this.source.length &&
      /\s/.test(this.source[this.pos]!)
    ) {
      this.advance();
    }
  }

  private loc(): SourceLocation {
    return { line: this.line, column: this.column, offset: this.pos };
  }

  private isDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch);
  }

  private isIdentChar(ch: string | undefined): boolean {
    return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  }
}
