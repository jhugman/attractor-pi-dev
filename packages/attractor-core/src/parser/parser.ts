import type {
  AstAttribute,
  AstEdgeDefaults,
  AstEdgeStmt,
  AstGraph,
  AstGraphAttrDecl,
  AstGraphAttrStmt,
  AstNodeDefaults,
  AstNodeStmt,
  AstStatement,
  AstSubgraph,
  AstValue,
  SourceLocation,
  SourceRange,
} from "./ast.js";
import { Lexer, type Token, TokenType } from "./lexer.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public loc: SourceLocation,
  ) {
    super(`${message} at line ${loc.line}, column ${loc.column}`);
    this.name = "ParseError";
  }
}

export class Parser {
  private tokens: Token[] = [];
  private pos = 0;

  parse(source: string): AstGraph {
    const lexer = new Lexer(source);
    this.tokens = lexer.tokenize();
    this.pos = 0;
    return this.parseGraph();
  }

  private parseGraph(): AstGraph {
    const startLoc = this.current().loc;
    this.expect(TokenType.Digraph);
    const id = this.expectIdentifier();
    this.expect(TokenType.LBrace);

    const body: AstStatement[] = [];
    while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }
    const endLoc = this.current().loc;
    this.expect(TokenType.RBrace);

    return { id, body, loc: this.range(startLoc, endLoc) };
  }

  private parseStatement(): AstStatement | null {
    this.skipSemicolons();
    if (this.check(TokenType.RBrace) || this.check(TokenType.EOF)) return null;

    const startLoc = this.current().loc;

    // graph [...]
    if (this.check(TokenType.Graph) && this.peekType(1) === TokenType.LBracket) {
      return this.parseGraphAttrStmt(startLoc);
    }

    // node [...] defaults
    if (this.check(TokenType.Node) && this.peekType(1) === TokenType.LBracket) {
      return this.parseNodeDefaults(startLoc);
    }

    // edge [...] defaults
    if (this.check(TokenType.Edge) && this.peekType(1) === TokenType.LBracket) {
      return this.parseEdgeDefaults(startLoc);
    }

    // subgraph
    if (this.check(TokenType.Subgraph)) {
      return this.parseSubgraph(startLoc);
    }

    // Identifier-based: could be node stmt, edge stmt, or graph attr decl
    if (this.isIdentifierLike()) {
      return this.parseIdentBasedStmt(startLoc);
    }

    throw new ParseError(
      `Unexpected token '${this.current().value}'`,
      this.current().loc,
    );
  }

  private parseGraphAttrStmt(startLoc: SourceLocation): AstGraphAttrStmt {
    this.advance(); // skip 'graph'
    const attrs = this.parseAttrBlock();
    this.skipSemicolons();
    return {
      kind: "graph_attr",
      attrs,
      loc: this.range(startLoc, this.prevLoc()),
    };
  }

  private parseNodeDefaults(startLoc: SourceLocation): AstNodeDefaults {
    this.advance(); // skip 'node'
    const attrs = this.parseAttrBlock();
    this.skipSemicolons();
    return {
      kind: "node_defaults",
      attrs,
      loc: this.range(startLoc, this.prevLoc()),
    };
  }

  private parseEdgeDefaults(startLoc: SourceLocation): AstEdgeDefaults {
    this.advance(); // skip 'edge'
    const attrs = this.parseAttrBlock();
    this.skipSemicolons();
    return {
      kind: "edge_defaults",
      attrs,
      loc: this.range(startLoc, this.prevLoc()),
    };
  }

  private parseSubgraph(startLoc: SourceLocation): AstSubgraph {
    this.advance(); // skip 'subgraph'
    let id: string | undefined;
    if (this.isIdentifierLike()) {
      id = this.current().value;
      this.advance();
    }
    this.expect(TokenType.LBrace);
    const body: AstStatement[] = [];
    while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }
    this.expect(TokenType.RBrace);
    this.skipSemicolons();
    return {
      kind: "subgraph",
      id,
      body,
      loc: this.range(startLoc, this.prevLoc()),
    };
  }

  private parseIdentBasedStmt(
    startLoc: SourceLocation,
  ): AstNodeStmt | AstEdgeStmt | AstGraphAttrDecl {
    const id = this.consumeIdentifier();

    // Graph-level attribute: key = value (not inside brackets)
    if (this.check(TokenType.Equals)) {
      this.advance(); // skip '='
      const value = this.parseValue();
      this.skipSemicolons();
      return {
        kind: "graph_attr_decl",
        key: id,
        value,
        loc: this.range(startLoc, this.prevLoc()),
      };
    }

    // Edge statement: id -> id2 -> id3 [...]
    if (this.check(TokenType.Arrow)) {
      const chain = [id];
      while (this.check(TokenType.Arrow)) {
        this.advance(); // skip '->'
        chain.push(this.consumeIdentifier());
      }
      const attrs = this.check(TokenType.LBracket) ? this.parseAttrBlock() : [];
      this.skipSemicolons();
      return {
        kind: "edge",
        chain,
        attrs,
        loc: this.range(startLoc, this.prevLoc()),
      };
    }

    // Node statement: id [...] or bare id
    const attrs = this.check(TokenType.LBracket) ? this.parseAttrBlock() : [];
    this.skipSemicolons();
    return {
      kind: "node",
      id,
      attrs,
      loc: this.range(startLoc, this.prevLoc()),
    };
  }

  private parseAttrBlock(): AstAttribute[] {
    this.expect(TokenType.LBracket);
    const attrs: AstAttribute[] = [];

    while (!this.check(TokenType.RBracket) && !this.check(TokenType.EOF)) {
      const attrLoc = this.current().loc;
      const key = this.consumeQualifiedId();
      this.expect(TokenType.Equals);
      const value = this.parseValue();
      attrs.push({ key, value, loc: this.range(attrLoc, this.prevLoc()) });

      // Comma between attrs (required by spec, but be lenient)
      if (this.check(TokenType.Comma)) {
        this.advance();
      }
    }

    this.expect(TokenType.RBracket);
    return attrs;
  }

  private parseValue(): AstValue {
    const token = this.current();
    switch (token.type) {
      case TokenType.String:
        this.advance();
        return { kind: "string", value: token.value };
      case TokenType.Integer:
        this.advance();
        return { kind: "integer", value: parseInt(token.value, 10) };
      case TokenType.Float:
        this.advance();
        return { kind: "float", value: parseFloat(token.value) };
      case TokenType.Duration: {
        this.advance();
        const match = token.value.match(/^(-?\d+)(ms|s|m|h|d)$/);
        if (!match) throw new ParseError(`Invalid duration: ${token.value}`, token.loc);
        return {
          kind: "duration",
          value: parseInt(match[1]!, 10),
          unit: match[2]!,
          raw: token.value,
        };
      }
      case TokenType.True:
        this.advance();
        return { kind: "boolean", value: true };
      case TokenType.False:
        this.advance();
        return { kind: "boolean", value: false };
      case TokenType.Identifier:
        // Unquoted identifier used as a value
        this.advance();
        return { kind: "identifier", value: token.value };
      default:
        throw new ParseError(
          `Expected value, got '${token.value}'`,
          token.loc,
        );
    }
  }

  private consumeIdentifier(): string {
    const token = this.current();
    if (this.isIdentifierLike()) {
      this.advance();
      return token.value;
    }
    throw new ParseError(
      `Expected identifier, got '${token.value}'`,
      token.loc,
    );
  }

  private expectIdentifier(): string {
    return this.consumeIdentifier();
  }

  /** Consume a possibly dot-qualified identifier like "tool_hooks.pre" */
  private consumeQualifiedId(): string {
    let id = this.consumeIdentifier();
    while (this.check(TokenType.Dot)) {
      this.advance(); // skip '.'
      id += "." + this.consumeIdentifier();
    }
    return id;
  }

  /** Check if current token can be treated as an identifier */
  private isIdentifierLike(): boolean {
    const t = this.current().type;
    // Allow keywords to be used as identifiers in node/edge position
    return (
      t === TokenType.Identifier ||
      t === TokenType.Graph ||
      t === TokenType.Node ||
      t === TokenType.Edge
    );
  }

  private expect(type: TokenType): Token {
    const token = this.current();
    if (token.type !== type) {
      throw new ParseError(
        `Expected '${type}', got '${token.value}'`,
        token.loc,
      );
    }
    this.advance();
    return token;
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private advance(): void {
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
  }

  private current(): Token {
    return this.tokens[this.pos]!;
  }

  private peekType(offset: number): TokenType {
    const idx = this.pos + offset;
    if (idx < this.tokens.length) {
      return this.tokens[idx]!.type;
    }
    return TokenType.EOF;
  }

  private prevLoc(): SourceLocation {
    if (this.pos > 0) {
      return this.tokens[this.pos - 1]!.loc;
    }
    return this.current().loc;
  }

  private skipSemicolons(): void {
    while (this.check(TokenType.Semicolon)) {
      this.advance();
    }
  }

  private range(start: SourceLocation, end: SourceLocation): SourceRange {
    return { start, end };
  }
}

/** Parse a DOT source string into an AST */
export function parseDot(source: string): AstGraph {
  return new Parser().parse(source);
}
