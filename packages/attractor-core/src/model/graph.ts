import type { HandlerType } from "./types.js";
import { SHAPE_TO_HANDLER_TYPE } from "./types.js";

/** A node in the pipeline graph */
export interface GraphNode {
  id: string;
  label: string;
  shape: string;
  type: string;
  prompt: string;
  maxRetries: number;
  goalGate: boolean;
  retryTarget: string;
  fallbackRetryTarget: string;
  fidelity: string;
  threadId: string;
  classes: string[];
  timeout: number | null;
  llmModel: string;
  llmProvider: string;
  reasoningEffort: string;
  autoStatus: boolean;
  allowPartial: boolean;
  attrs: Record<string, unknown>;
}

/** An edge in the pipeline graph */
export interface GraphEdge {
  fromNode: string;
  toNode: string;
  label: string;
  condition: string;
  weight: number;
  fidelity: string;
  threadId: string;
  loopRestart: boolean;
  attrs: Record<string, unknown>;
}

/** Graph-level attributes */
export interface GraphAttrs {
  goal: string;
  label: string;
  modelStylesheet: string;
  defaultMaxRetry: number;
  retryTarget: string;
  fallbackRetryTarget: string;
  defaultFidelity: string;
  [key: string]: unknown;
}

/** The complete pipeline graph */
export class Graph {
  id: string;
  attrs: GraphAttrs;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];

  constructor(
    id: string,
    attrs: GraphAttrs,
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
  ) {
    this.id = id;
    this.attrs = attrs;
    this.nodes = nodes;
    this.edges = edges;
  }

  get goal(): string {
    return this.attrs.goal;
  }

  /** Get a node by ID or throw */
  getNode(id: string): GraphNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    return node;
  }

  /** Get outgoing edges for a node */
  outgoingEdges(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.fromNode === nodeId);
  }

  /** Get incoming edges for a node */
  incomingEdges(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.toNode === nodeId);
  }

  /** Find start node (shape=Mdiamond or id=start/Start) */
  findStartNode(): GraphNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.shape === "Mdiamond") return node;
    }
    for (const node of this.nodes.values()) {
      if (node.id === "start" || node.id === "Start") return node;
    }
    return undefined;
  }

  /** Find exit node (shape=Msquare or id=exit/end) */
  findExitNode(): GraphNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.shape === "Msquare") return node;
    }
    for (const node of this.nodes.values()) {
      if (node.id === "exit" || node.id === "end" || node.id === "Exit" || node.id === "End")
        return node;
    }
    return undefined;
  }

  /** Resolve handler type for a node */
  resolveHandlerType(node: GraphNode): HandlerType {
    if (node.type) return node.type;
    return SHAPE_TO_HANDLER_TYPE[node.shape] ?? "codergen";
  }

  /** Check if a node is terminal (exit type) */
  isTerminal(node: GraphNode): boolean {
    const handlerType = this.resolveHandlerType(node);
    return handlerType === "exit";
  }

  /** Get all node IDs reachable from startId via BFS */
  reachableFrom(startId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of this.outgoingEdges(current)) {
        if (!visited.has(edge.toNode)) {
          queue.push(edge.toNode);
        }
      }
    }
    return visited;
  }
}
