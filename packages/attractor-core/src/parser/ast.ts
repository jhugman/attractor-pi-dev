/** Source location for error reporting */
export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
}

export interface SourceRange {
  start: SourceLocation;
  end: SourceLocation;
}

/** AST attribute key-value pair */
export interface AstAttribute {
  key: string;
  value: AstValue;
  loc?: SourceRange;
}

/** Typed AST value */
export type AstValue =
  | { kind: "string"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "float"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "duration"; value: number; unit: string; raw: string }
  | { kind: "identifier"; value: string };

/** Node statement: `nodeId [attr=val, ...]` */
export interface AstNodeStmt {
  kind: "node";
  id: string;
  attrs: AstAttribute[];
  loc?: SourceRange;
}

/** Edge statement: `a -> b -> c [attr=val, ...]` */
export interface AstEdgeStmt {
  kind: "edge";
  chain: string[];
  attrs: AstAttribute[];
  loc?: SourceRange;
}

/** Graph attribute statement: `graph [attr=val, ...]` */
export interface AstGraphAttrStmt {
  kind: "graph_attr";
  attrs: AstAttribute[];
  loc?: SourceRange;
}

/** Node defaults: `node [attr=val, ...]` */
export interface AstNodeDefaults {
  kind: "node_defaults";
  attrs: AstAttribute[];
  loc?: SourceRange;
}

/** Edge defaults: `edge [attr=val, ...]` */
export interface AstEdgeDefaults {
  kind: "edge_defaults";
  attrs: AstAttribute[];
  loc?: SourceRange;
}

/** Graph-level attribute declaration: `key = value` */
export interface AstGraphAttrDecl {
  kind: "graph_attr_decl";
  key: string;
  value: AstValue;
  loc?: SourceRange;
}

/** Subgraph block */
export interface AstSubgraph {
  kind: "subgraph";
  id?: string;
  body: AstStatement[];
  loc?: SourceRange;
}

export type AstStatement =
  | AstNodeStmt
  | AstEdgeStmt
  | AstGraphAttrStmt
  | AstNodeDefaults
  | AstEdgeDefaults
  | AstGraphAttrDecl
  | AstSubgraph;

/** Root AST node: `digraph Name { ... }` */
export interface AstGraph {
  id: string;
  body: AstStatement[];
  loc?: SourceRange;
}
