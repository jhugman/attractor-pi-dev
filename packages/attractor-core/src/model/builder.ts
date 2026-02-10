import type {
  AstAttribute,
  AstGraph,
  AstStatement,
  AstValue,
} from "../parser/ast.js";
import { Graph, type GraphAttrs, type GraphEdge, type GraphNode } from "./graph.js";
import { parseDuration } from "./types.js";

/** Convert an AST value to a plain JS value */
function astValueToPlain(v: AstValue): unknown {
  switch (v.kind) {
    case "string":
      return v.value;
    case "integer":
      return v.value;
    case "float":
      return v.value;
    case "boolean":
      return v.value;
    case "duration":
      return v.raw;
    case "identifier":
      return v.value;
  }
}

function astValueToString(v: AstValue): string {
  return String(astValueToPlain(v));
}

function astValueToInt(v: AstValue, fallback: number): number {
  if (v.kind === "integer") return v.value;
  const n = parseInt(String(astValueToPlain(v)), 10);
  return isNaN(n) ? fallback : n;
}

function astValueToBool(v: AstValue): boolean {
  if (v.kind === "boolean") return v.value;
  const s = String(astValueToPlain(v)).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

interface BuildContext {
  nodeDefaults: Record<string, AstValue>;
  edgeDefaults: Record<string, AstValue>;
  subgraphClasses: string[];
  subgraphLabel?: string;
}

/** Build a semantic Graph from an AST */
export function buildGraph(ast: AstGraph): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const graphAttrs: Record<string, unknown> = {};

  const ctx: BuildContext = {
    nodeDefaults: {},
    edgeDefaults: {},
    subgraphClasses: [],
  };

  processStatements(ast.body, ctx, nodes, edges, graphAttrs);

  const attrs = resolveGraphAttrs(graphAttrs);
  return new Graph(ast.id, attrs, nodes, edges);
}

function processStatements(
  stmts: AstStatement[],
  ctx: BuildContext,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  graphAttrs: Record<string, unknown>,
): void {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "graph_attr": {
        for (const attr of stmt.attrs) {
          graphAttrs[attr.key] = astValueToPlain(attr.value);
        }
        break;
      }
      case "graph_attr_decl": {
        graphAttrs[stmt.key] = astValueToPlain(stmt.value);
        break;
      }
      case "node_defaults": {
        for (const attr of stmt.attrs) {
          ctx.nodeDefaults[attr.key] = attr.value;
        }
        break;
      }
      case "edge_defaults": {
        for (const attr of stmt.attrs) {
          ctx.edgeDefaults[attr.key] = attr.value;
        }
        break;
      }
      case "node": {
        const node = buildNode(stmt.id, stmt.attrs, ctx);
        nodes.set(stmt.id, node);
        break;
      }
      case "edge": {
        // Expand chained edges: A -> B -> C => (A->B, B->C)
        for (let i = 0; i < stmt.chain.length - 1; i++) {
          const from = stmt.chain[i]!;
          const to = stmt.chain[i + 1]!;
          const edge = buildEdge(from, to, stmt.attrs, ctx);
          edges.push(edge);
          // Ensure nodes referenced in edges exist (bare references)
          if (!nodes.has(from)) nodes.set(from, buildNode(from, [], ctx));
          if (!nodes.has(to)) nodes.set(to, buildNode(to, [], ctx));
        }
        break;
      }
      case "subgraph": {
        // Derive class from subgraph label
        const subCtx: BuildContext = {
          nodeDefaults: { ...ctx.nodeDefaults },
          edgeDefaults: { ...ctx.edgeDefaults },
          subgraphClasses: [...ctx.subgraphClasses],
          subgraphLabel: undefined,
        };
        // Process subgraph body to find label and defaults
        for (const sub of stmt.body) {
          if (sub.kind === "node_defaults") {
            for (const attr of sub.attrs) {
              subCtx.nodeDefaults[attr.key] = attr.value;
            }
          } else if (sub.kind === "edge_defaults") {
            for (const attr of sub.attrs) {
              subCtx.edgeDefaults[attr.key] = attr.value;
            }
          } else if (sub.kind === "graph_attr") {
            for (const attr of sub.attrs) {
              if (attr.key === "label") {
                subCtx.subgraphLabel = astValueToString(attr.value);
              }
            }
          } else if (sub.kind === "graph_attr_decl" && sub.key === "label") {
            subCtx.subgraphLabel = astValueToString(sub.value);
          }
        }
        // Derive class from label
        if (subCtx.subgraphLabel) {
          const derived = deriveClassName(subCtx.subgraphLabel);
          if (derived) subCtx.subgraphClasses.push(derived);
        }
        // Process remaining statements
        processStatements(stmt.body, subCtx, nodes, edges, graphAttrs);
        break;
      }
    }
  }
}

function buildNode(
  id: string,
  explicitAttrs: AstAttribute[],
  ctx: BuildContext,
): GraphNode {
  // Merge defaults then explicit
  const merged = new Map<string, AstValue>();
  for (const [k, v] of Object.entries(ctx.nodeDefaults)) {
    merged.set(k, v);
  }
  for (const attr of explicitAttrs) {
    merged.set(attr.key, attr.value);
  }

  const get = (key: string): string => {
    const v = merged.get(key);
    return v ? astValueToString(v) : "";
  };

  const getInt = (key: string, fallback: number): number => {
    const v = merged.get(key);
    return v ? astValueToInt(v, fallback) : fallback;
  };

  const getBool = (key: string, fallback: boolean): boolean => {
    const v = merged.get(key);
    return v ? astValueToBool(v) : fallback;
  };

  // Parse classes from explicit class attr + subgraph-derived classes
  const classStr = get("class");
  const explicitClasses = classStr
    ? classStr.split(",").map((c) => c.trim()).filter(Boolean)
    : [];
  const classes = [...ctx.subgraphClasses, ...explicitClasses];

  // Parse timeout
  const timeoutRaw = get("timeout");
  let timeout: number | null = null;
  if (timeoutRaw) {
    try {
      timeout = parseDuration(timeoutRaw);
    } catch {
      // leave null
    }
  }

  // Collect remaining attrs
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of merged) {
    attrs[k] = astValueToPlain(v);
  }

  return {
    id,
    label: get("label") || id,
    shape: get("shape") || "box",
    type: get("type"),
    prompt: get("prompt"),
    maxRetries: getInt("max_retries", 0),
    goalGate: getBool("goal_gate", false),
    retryTarget: get("retry_target"),
    fallbackRetryTarget: get("fallback_retry_target"),
    fidelity: get("fidelity"),
    threadId: get("thread_id"),
    classes,
    timeout,
    llmModel: get("llm_model"),
    llmProvider: get("llm_provider"),
    reasoningEffort: get("reasoning_effort") || "high",
    autoStatus: getBool("auto_status", false),
    allowPartial: getBool("allow_partial", false),
    attrs,
  };
}

function buildEdge(
  from: string,
  to: string,
  explicitAttrs: AstAttribute[],
  ctx: BuildContext,
): GraphEdge {
  const merged = new Map<string, AstValue>();
  for (const [k, v] of Object.entries(ctx.edgeDefaults)) {
    merged.set(k, v);
  }
  for (const attr of explicitAttrs) {
    merged.set(attr.key, attr.value);
  }

  const get = (key: string): string => {
    const v = merged.get(key);
    return v ? astValueToString(v) : "";
  };

  const getInt = (key: string, fallback: number): number => {
    const v = merged.get(key);
    return v ? astValueToInt(v, fallback) : fallback;
  };

  const getBool = (key: string, fallback: boolean): boolean => {
    const v = merged.get(key);
    return v ? astValueToBool(v) : fallback;
  };

  const attrs: Record<string, unknown> = {};
  for (const [k, v] of merged) {
    attrs[k] = astValueToPlain(v);
  }

  return {
    fromNode: from,
    toNode: to,
    label: get("label"),
    condition: get("condition"),
    weight: getInt("weight", 0),
    fidelity: get("fidelity"),
    threadId: get("thread_id"),
    loopRestart: getBool("loop_restart", false),
    attrs,
  };
}

/** Derive a CSS-like class name from a subgraph label */
function deriveClassName(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function resolveGraphAttrs(raw: Record<string, unknown>): GraphAttrs {
  const str = (key: string, def = ""): string => {
    const v = raw[key];
    return v !== undefined ? String(v) : def;
  };
  const int = (key: string, def: number): number => {
    const v = raw[key];
    if (v === undefined) return def;
    const n = parseInt(String(v), 10);
    return isNaN(n) ? def : n;
  };
  return {
    goal: str("goal"),
    label: str("label"),
    modelStylesheet: str("model_stylesheet"),
    defaultMaxRetry: int("default_max_retry", 50),
    retryTarget: str("retry_target"),
    fallbackRetryTarget: str("fallback_retry_target"),
    defaultFidelity: str("default_fidelity"),
    ...raw,
  };
}
