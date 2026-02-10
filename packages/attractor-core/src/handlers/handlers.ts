import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphNode } from "../model/graph.js";
import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, successOutcome, failOutcome } from "../state/types.js";
import type {
  Handler,
  CodergenBackend,
  Interviewer,
  QuestionOption,
} from "./types.js";
import { QuestionType, AnswerValue } from "./types.js";

/** Start handler: no-op, returns SUCCESS */
export class StartHandler implements Handler {
  async execute(): Promise<Outcome> {
    return successOutcome();
  }
}

/** Exit handler: no-op, returns SUCCESS */
export class ExitHandler implements Handler {
  async execute(): Promise<Outcome> {
    return successOutcome();
  }
}

/** Conditional handler: pass-through, engine evaluates edge conditions */
export class ConditionalHandler implements Handler {
  async execute(node: GraphNode): Promise<Outcome> {
    return successOutcome({ notes: `Conditional node evaluated: ${node.id}` });
  }
}

/** Codergen (LLM) handler */
export class CodergenHandler implements Handler {
  constructor(private backend: CodergenBackend | null = null) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    // 1. Build prompt
    let prompt = node.prompt || node.label;
    prompt = prompt.replaceAll("$goal", graph.attrs.goal);

    // 2. Write prompt to logs
    const stageDir = path.join(logsRoot, node.id);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, "prompt.md"), prompt);

    // 3. Call LLM backend
    let responseText: string;
    if (this.backend) {
      try {
        const result = await this.backend.run(node, prompt, context);
        if (typeof result === "object" && "status" in result) {
          writeStatus(stageDir, result as Outcome);
          return result as Outcome;
        }
        responseText = String(result);
      } catch (err) {
        return failOutcome(String(err));
      }
    } else {
      responseText = `[Simulated] Response for stage: ${node.id}`;
    }

    // 4. Write response to logs
    fs.writeFileSync(path.join(stageDir, "response.md"), responseText);

    // 5. Return outcome
    const outcome: Outcome = {
      status: StageStatus.SUCCESS,
      notes: `Stage completed: ${node.id}`,
      contextUpdates: {
        last_stage: node.id,
        last_response: responseText.slice(0, 200),
      },
    };
    writeStatus(stageDir, outcome);
    return outcome;
  }
}

/** Wait for human handler */
export class WaitForHumanHandler implements Handler {
  constructor(private interviewer: Interviewer) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const edges = graph.outgoingEdges(node.id);
    const choices: Array<{ key: string; label: string; to: string }> = [];

    for (const edge of edges) {
      const label = edge.label || edge.toNode;
      const key = parseAcceleratorKey(label);
      choices.push({ key, label, to: edge.toNode });
    }

    if (choices.length === 0) {
      return failOutcome("No outgoing edges for human gate");
    }

    const options: QuestionOption[] = choices.map((c) => ({
      key: c.key,
      label: c.label,
    }));

    const answer = await this.interviewer.ask({
      text: node.label || "Select an option:",
      type: QuestionType.MULTIPLE_CHOICE,
      options,
      stage: node.id,
    });

    // Handle timeout
    if (answer.value === AnswerValue.TIMEOUT) {
      const defaultChoice = node.attrs["human.default_choice"] as string | undefined;
      if (defaultChoice) {
        const found = choices.find((c) => c.key === defaultChoice || c.to === defaultChoice);
        if (found) {
          return successOutcome({
            suggestedNextIds: [found.to],
            contextUpdates: {
              "human.gate.selected": found.key,
              "human.gate.label": found.label,
            },
          });
        }
      }
      return {
        status: StageStatus.RETRY,
        failureReason: "human gate timeout, no default",
      };
    }

    if (answer.value === AnswerValue.SKIPPED) {
      return failOutcome("human skipped interaction");
    }

    // Find matching choice
    const selected =
      choices.find(
        (c) =>
          c.key.toLowerCase() === String(answer.value).toLowerCase() ||
          c.label.toLowerCase() === String(answer.value).toLowerCase(),
      ) || choices[0]!;

    return successOutcome({
      suggestedNextIds: [selected.to],
      contextUpdates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
      },
    });
  }
}

/** Parallel fan-out handler */
export class ParallelHandler implements Handler {
  private executeSubgraph?: (
    startNodeId: string,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ) => Promise<Outcome>;

  setSubgraphExecutor(
    fn: (
      startNodeId: string,
      context: Context,
      graph: Graph,
      logsRoot: string,
    ) => Promise<Outcome>,
  ): void {
    this.executeSubgraph = fn;
  }

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const branches = graph.outgoingEdges(node.id);
    const joinPolicy = (node.attrs["join_policy"] as string) || "wait_all";

    if (!this.executeSubgraph) {
      // Fallback: just mark success
      return successOutcome({ notes: "Parallel handler (no subgraph executor)" });
    }

    const results: Outcome[] = [];
    // Execute branches concurrently
    const promises = branches.map(async (branch) => {
      const branchContext = context.clone();
      return this.executeSubgraph!(branch.toNode, branchContext, graph, logsRoot);
    });

    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push(failOutcome(String(result.reason)));
      }
    }

    const successCount = results.filter((r) => r.status === StageStatus.SUCCESS).length;
    const failCount = results.filter((r) => r.status === StageStatus.FAIL).length;

    context.set("parallel.results", JSON.stringify(results));

    if (joinPolicy === "first_success") {
      return successCount > 0
        ? successOutcome({ notes: `${successCount}/${results.length} branches succeeded` })
        : failOutcome("All branches failed");
    }

    // wait_all
    if (failCount === 0) {
      return successOutcome({ notes: `All ${results.length} branches succeeded` });
    }
    return {
      status: StageStatus.PARTIAL_SUCCESS,
      notes: `${successCount}/${results.length} branches succeeded`,
    };
  }
}

/** Fan-in handler */
export class FanInHandler implements Handler {
  async execute(
    node: GraphNode,
    context: Context,
  ): Promise<Outcome> {
    const resultsRaw = context.getString("parallel.results");
    if (!resultsRaw) {
      return failOutcome("No parallel results to evaluate");
    }

    let results: Outcome[];
    try {
      results = JSON.parse(resultsRaw) as Outcome[];
    } catch {
      return failOutcome("Failed to parse parallel results");
    }

    // Heuristic select: rank by status, pick best
    const statusRank: Record<string, number> = {
      [StageStatus.SUCCESS]: 0,
      [StageStatus.PARTIAL_SUCCESS]: 1,
      [StageStatus.RETRY]: 2,
      [StageStatus.FAIL]: 3,
      [StageStatus.SKIPPED]: 4,
    };

    results.sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9));

    const best = results[0];
    if (!best) return failOutcome("No candidates available");

    return successOutcome({
      contextUpdates: {
        "parallel.fan_in.best_outcome": best.status,
      },
      notes: `Selected best candidate with status: ${best.status}`,
    });
  }
}

/** Tool handler: executes shell commands */
export class ToolHandler implements Handler {
  async execute(
    node: GraphNode,
    _context: Context,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const command = node.attrs["tool_command"] as string | undefined;
    if (!command) {
      return failOutcome("No tool_command specified");
    }

    try {
      const { execSync } = await import("node:child_process");
      const timeout = node.timeout ?? 30000;
      const result = execSync(command, {
        timeout,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return successOutcome({
        contextUpdates: { "tool.output": result },
        notes: `Tool completed: ${command}`,
      });
    } catch (err) {
      return failOutcome(String(err));
    }
  }
}

/** Manager loop handler (simplified) */
export class ManagerLoopHandler implements Handler {
  async execute(
    node: GraphNode,
    context: Context,
  ): Promise<Outcome> {
    // Simplified implementation: just mark success
    const maxCycles = parseInt(String(node.attrs["manager.max_cycles"] ?? "1000"), 10);
    return successOutcome({
      notes: `Manager loop completed (max_cycles=${maxCycles})`,
    });
  }
}

// ── Helpers ──

function writeStatus(stageDir: string, outcome: Outcome): void {
  const data = {
    outcome: outcome.status,
    preferred_next_label: outcome.preferredLabel ?? "",
    suggested_next_ids: outcome.suggestedNextIds ?? [],
    context_updates: outcome.contextUpdates ?? {},
    notes: outcome.notes ?? "",
  };
  fs.writeFileSync(
    path.join(stageDir, "status.json"),
    JSON.stringify(data, null, 2),
  );
}

/**
 * Parse accelerator key from edge label.
 * Patterns: [K] Label, K) Label, K - Label, or first character.
 */
function parseAcceleratorKey(label: string): string {
  // [K] Label
  const bracketMatch = label.match(/^\[([A-Za-z0-9])\]\s*/);
  if (bracketMatch) return bracketMatch[1]!;

  // K) Label
  const parenMatch = label.match(/^([A-Za-z0-9])\)\s*/);
  if (parenMatch) return parenMatch[1]!;

  // K - Label
  const dashMatch = label.match(/^([A-Za-z0-9])\s*-\s*/);
  if (dashMatch) return dashMatch[1]!;

  // First character
  return label.charAt(0).toUpperCase();
}
