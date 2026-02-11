import type { Graph, GraphNode } from "../model/graph.js";
import { SHAPE_TO_HANDLER_TYPE, VALID_FIDELITY_MODES } from "../model/types.js";
import { validateConditionSyntax } from "../conditions/index.js";
import { validateStylesheetSyntax } from "../stylesheet/index.js";

export enum Severity {
  ERROR = "error",
  WARNING = "warning",
  INFO = "info",
}

export interface Diagnostic {
  rule: string;
  severity: Severity;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
  fix?: string;
}

export interface LintRule {
  name: string;
  apply(graph: Graph): Diagnostic[];
}

// ── ERROR rules ──

const startNodeRule: LintRule = {
  name: "start_node",
  apply(graph) {
    const startNodes = [...graph.nodes.values()].filter(
      (n) => n.shape === "Mdiamond" || n.id === "start" || n.id === "Start",
    );
    if (startNodes.length === 0) {
      return [
        {
          rule: "start_node",
          severity: Severity.ERROR,
          message: "Pipeline must have exactly one start node (shape=Mdiamond)",
          fix: 'Add a node with shape=Mdiamond, e.g.: start [shape=Mdiamond, label="Start"]',
        },
      ];
    }
    if (startNodes.length > 1) {
      return [
        {
          rule: "start_node",
          severity: Severity.ERROR,
          message: `Pipeline has ${startNodes.length} start nodes; expected exactly one`,
        },
      ];
    }
    return [];
  },
};

const terminalNodeRule: LintRule = {
  name: "terminal_node",
  apply(graph) {
    const exitNodes = [...graph.nodes.values()].filter(
      (n) =>
        n.shape === "Msquare" ||
        n.id === "exit" ||
        n.id === "end" ||
        n.id === "Exit" ||
        n.id === "End",
    );
    if (exitNodes.length === 0) {
      return [
        {
          rule: "terminal_node",
          severity: Severity.ERROR,
          message:
            "Pipeline must have at least one terminal node (shape=Msquare)",
          fix: 'Add a node with shape=Msquare, e.g.: exit [shape=Msquare, label="Exit"]',
        },
      ];
    }
    return [];
  },
};

const reachabilityRule: LintRule = {
  name: "reachability",
  apply(graph) {
    const start = graph.findStartNode();
    if (!start) return []; // start_node rule covers this
    const reachable = graph.reachableFrom(start.id);
    const diags: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (!reachable.has(node.id)) {
        diags.push({
          rule: "reachability",
          severity: Severity.ERROR,
          message: `Node '${node.id}' is not reachable from the start node`,
          nodeId: node.id,
        });
      }
    }
    return diags;
  },
};

const edgeTargetExistsRule: LintRule = {
  name: "edge_target_exists",
  apply(graph) {
    const diags: Diagnostic[] = [];
    for (const edge of graph.edges) {
      if (!graph.nodes.has(edge.fromNode)) {
        diags.push({
          rule: "edge_target_exists",
          severity: Severity.ERROR,
          message: `Edge source '${edge.fromNode}' does not exist`,
          edge: { from: edge.fromNode, to: edge.toNode },
        });
      }
      if (!graph.nodes.has(edge.toNode)) {
        diags.push({
          rule: "edge_target_exists",
          severity: Severity.ERROR,
          message: `Edge target '${edge.toNode}' does not exist`,
          edge: { from: edge.fromNode, to: edge.toNode },
        });
      }
    }
    return diags;
  },
};

const startNoIncomingRule: LintRule = {
  name: "start_no_incoming",
  apply(graph) {
    const start = graph.findStartNode();
    if (!start) return [];
    const incoming = graph.incomingEdges(start.id);
    if (incoming.length > 0) {
      return [
        {
          rule: "start_no_incoming",
          severity: Severity.ERROR,
          message: `Start node '${start.id}' must have no incoming edges`,
          nodeId: start.id,
        },
      ];
    }
    return [];
  },
};

const exitNoOutgoingRule: LintRule = {
  name: "exit_no_outgoing",
  apply(graph) {
    const exit = graph.findExitNode();
    if (!exit) return [];
    const outgoing = graph.outgoingEdges(exit.id);
    if (outgoing.length > 0) {
      return [
        {
          rule: "exit_no_outgoing",
          severity: Severity.ERROR,
          message: `Exit node '${exit.id}' must have no outgoing edges`,
          nodeId: exit.id,
        },
      ];
    }
    return [];
  },
};

const conditionSyntaxRule: LintRule = {
  name: "condition_syntax",
  apply(graph) {
    const diags: Diagnostic[] = [];
    for (const edge of graph.edges) {
      if (edge.condition) {
        const err = validateConditionSyntax(edge.condition);
        if (err) {
          diags.push({
            rule: "condition_syntax",
            severity: Severity.ERROR,
            message: `Invalid condition on edge ${edge.fromNode} -> ${edge.toNode}: ${err}`,
            edge: { from: edge.fromNode, to: edge.toNode },
          });
        }
      }
    }
    return diags;
  },
};

const stylesheetSyntaxRule: LintRule = {
  name: "stylesheet_syntax",
  apply(graph) {
    const source = graph.attrs.modelStylesheet;
    if (!source) return [];
    const err = validateStylesheetSyntax(source);
    if (err) {
      return [
        {
          rule: "stylesheet_syntax",
          severity: Severity.ERROR,
          message: `Invalid model_stylesheet: ${err}`,
        },
      ];
    }
    return [];
  },
};

// ── WARNING rules ──

const KNOWN_HANDLER_TYPES = new Set([
  "start",
  "exit",
  "codergen",
  "wait.human",
  "conditional",
  "parallel",
  "parallel.fan_in",
  "tool",
  "stack.manager_loop",
]);

const typeKnownRule: LintRule = {
  name: "type_known",
  apply(graph) {
    const diags: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (node.type && !KNOWN_HANDLER_TYPES.has(node.type)) {
        diags.push({
          rule: "type_known",
          severity: Severity.WARNING,
          message: `Unknown handler type '${node.type}' on node '${node.id}'`,
          nodeId: node.id,
        });
      }
    }
    return diags;
  },
};

const fidelityValidRule: LintRule = {
  name: "fidelity_valid",
  apply(graph) {
    const diags: Diagnostic[] = [];
    const checkFidelity = (value: string, context: string, nodeId?: string) => {
      if (value && !VALID_FIDELITY_MODES.includes(value)) {
        diags.push({
          rule: "fidelity_valid",
          severity: Severity.WARNING,
          message: `Invalid fidelity mode '${value}' on ${context}`,
          nodeId,
        });
      }
    };
    if (graph.attrs.defaultFidelity) {
      checkFidelity(graph.attrs.defaultFidelity, "graph default_fidelity");
    }
    for (const node of graph.nodes.values()) {
      checkFidelity(node.fidelity, `node '${node.id}'`, node.id);
    }
    for (const edge of graph.edges) {
      checkFidelity(
        edge.fidelity,
        `edge ${edge.fromNode} -> ${edge.toNode}`,
      );
    }
    return diags;
  },
};

const retryTargetExistsRule: LintRule = {
  name: "retry_target_exists",
  apply(graph) {
    const diags: Diagnostic[] = [];
    const check = (target: string, context: string, nodeId?: string) => {
      if (target && !graph.nodes.has(target)) {
        diags.push({
          rule: "retry_target_exists",
          severity: Severity.WARNING,
          message: `Retry target '${target}' on ${context} does not exist`,
          nodeId,
        });
      }
    };
    check(graph.attrs.retryTarget, "graph retry_target");
    check(graph.attrs.fallbackRetryTarget, "graph fallback_retry_target");
    for (const node of graph.nodes.values()) {
      check(node.retryTarget, `node '${node.id}'`, node.id);
      check(node.fallbackRetryTarget, `node '${node.id}'`, node.id);
    }
    return diags;
  },
};

const goalGateHasRetryRule: LintRule = {
  name: "goal_gate_has_retry",
  apply(graph) {
    const diags: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (
        node.goalGate &&
        !node.retryTarget &&
        !node.fallbackRetryTarget &&
        !graph.attrs.retryTarget &&
        !graph.attrs.fallbackRetryTarget
      ) {
        diags.push({
          rule: "goal_gate_has_retry",
          severity: Severity.WARNING,
          message: `Node '${node.id}' has goal_gate=true but no retry_target configured at node or graph level`,
          nodeId: node.id,
        });
      }
    }
    return diags;
  },
};

const promptOnLlmNodesRule: LintRule = {
  name: "prompt_on_llm_nodes",
  apply(graph) {
    const diags: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      const handlerType = graph.resolveHandlerType(node);
      if (handlerType === "codergen" && !node.prompt && node.label === node.id) {
        diags.push({
          rule: "prompt_on_llm_nodes",
          severity: Severity.WARNING,
          message: `LLM node '${node.id}' has no prompt and label is the same as ID`,
          nodeId: node.id,
          fix: "Add a prompt attribute or meaningful label",
        });
      }
    }
    return diags;
  },
};

const varsDeclaredRule: LintRule = {
  name: "vars_declared",
  apply(graph) {
    // Skip if vars was not explicitly declared (backward compat)
    if (!graph.attrs.varsExplicit) return [];

    const declaredNames = new Set(graph.attrs.vars.map((v) => v.name));
    const diags: Diagnostic[] = [];
    const varPattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

    for (const node of graph.nodes.values()) {
      for (const field of [node.prompt, node.label]) {
        if (!field) continue;
        let match;
        varPattern.lastIndex = 0;
        while ((match = varPattern.exec(field)) !== null) {
          const varName = match[1]!;
          if (!declaredNames.has(varName)) {
            diags.push({
              rule: "vars_declared",
              severity: Severity.ERROR,
              message: `Variable '$${varName}' used in node '${node.id}' is not declared in graph vars`,
              nodeId: node.id,
              fix: `Add '${varName}' to graph [vars="..."]`,
            });
          }
        }
      }
    }
    return diags;
  },
};

const promptFileExistsRule: LintRule = {
  name: "prompt_file_exists",
  apply(graph) {
    const unresolvedFiles = graph.attrs._unresolvedPromptFiles as
      | Array<{ nodeId: string; filePath: string }>
      | undefined;
    if (!unresolvedFiles) return [];
    return unresolvedFiles.map((entry) => ({
      rule: "prompt_file_exists",
      severity: Severity.ERROR,
      message: `Prompt file not found: ${entry.filePath}`,
      nodeId: entry.nodeId,
    }));
  },
};

const promptCommandExistsRule: LintRule = {
  name: "prompt_command_exists",
  apply(graph) {
    const unresolvedCommands = graph.attrs._unresolvedPromptCommands as
      | Array<{ nodeId: string; commandName: string; searchedPaths: string[] }>
      | undefined;
    if (!unresolvedCommands) return [];
    return unresolvedCommands.map((entry) => ({
      rule: "prompt_command_exists",
      severity: Severity.ERROR,
      message: `Command '${entry.commandName}' not found. Searched:\n${entry.searchedPaths.map((p) => `  - ${p}`).join("\n")}`,
      nodeId: entry.nodeId,
    }));
  },
};

/** All built-in lint rules */
export const BUILT_IN_RULES: LintRule[] = [
  startNodeRule,
  terminalNodeRule,
  reachabilityRule,
  edgeTargetExistsRule,
  startNoIncomingRule,
  exitNoOutgoingRule,
  conditionSyntaxRule,
  stylesheetSyntaxRule,
  typeKnownRule,
  fidelityValidRule,
  retryTargetExistsRule,
  goalGateHasRetryRule,
  promptOnLlmNodesRule,
  varsDeclaredRule,
  promptFileExistsRule,
  promptCommandExistsRule,
];

/** Validate a graph, returning all diagnostics */
export function validate(
  graph: Graph,
  extraRules?: LintRule[],
): Diagnostic[] {
  const rules = extraRules ? [...BUILT_IN_RULES, ...extraRules] : BUILT_IN_RULES;
  const diagnostics: Diagnostic[] = [];
  for (const rule of rules) {
    diagnostics.push(...rule.apply(graph));
  }
  return diagnostics;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Validate a graph; throw if any ERROR-level diagnostics */
export function validateOrRaise(
  graph: Graph,
  extraRules?: LintRule[],
): Diagnostic[] {
  const diagnostics = validate(graph, extraRules);
  const errors = diagnostics.filter((d) => d.severity === Severity.ERROR);
  if (errors.length > 0) {
    const messages = errors.map((e) => `[${e.rule}] ${e.message}`).join("\n");
    throw new ValidationError(
      `Pipeline validation failed with ${errors.length} error(s):\n${messages}`,
      errors,
    );
  }
  return diagnostics;
}
