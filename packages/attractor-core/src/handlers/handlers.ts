import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphNode } from "../model/graph.js";
import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, successOutcome, failOutcome } from "../state/types.js";
import { applyFidelity, resolveEffectiveFidelity } from "../state/fidelity.js";
import type {
  Handler,
  CodergenBackend,
  Interviewer,
  QuestionOption,
  ManagerObserver,
} from "./types.js";
import { QuestionType, AnswerValue } from "./types.js";
import { evaluateCondition } from "../conditions/index.js";
import { parseDuration } from "../model/types.js";
import { sleep } from "../engine/retry.js";

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

    // 2. Write original prompt to logs
    const stageDir = path.join(logsRoot, node.id);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, "prompt.md"), prompt);

    // 3. Build fidelity-filtered context for the LLM backend
    // Edge fidelity is stored in context by the runner before handler execution
    const edgeFidelity = context.getString("internal.incoming_edge_fidelity");
    const fidelityMode = resolveEffectiveFidelity(
      edgeFidelity,
      node.fidelity,
      graph.attrs.defaultFidelity,
    );
    const filteredSnapshot = applyFidelity(context.snapshot(), fidelityMode);
    const filteredContext = context.clone();
    // Replace the cloned context's values with the fidelity-filtered snapshot
    for (const key of Object.keys(filteredContext.snapshot())) {
      filteredContext.delete(key);
    }
    filteredContext.applyUpdates(filteredSnapshot);

    // 4. Preamble synthesis (spec §9.2): when fidelity is not "full", prepend
    //    a text summary of the filtered context so the LLM has enough context
    //    to continue work without full conversation history.
    if (fidelityMode !== "full") {
      const preamble = synthesizePreamble(filteredSnapshot);
      if (preamble) {
        prompt = preamble + "\n\n" + prompt;
      }
    }

    // 5. Call LLM backend
    let responseText: string;
    if (this.backend) {
      try {
        const result = await this.backend.run(node, prompt, filteredContext);
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

    // 6. Write response to logs
    fs.writeFileSync(path.join(stageDir, "response.md"), responseText);

    // 7. Return outcome
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
    const errorPolicy = (node.attrs["error_policy"] as string) || "continue";
    const maxParallel = parseInt(String(node.attrs["max_parallel"] ?? "4"), 10);

    if (!this.executeSubgraph) {
      // Fallback: just mark success
      return successOutcome({ notes: "Parallel handler (no subgraph executor)" });
    }

    // Execute branches with bounded parallelism and error policy
    const results = await this.executeBranches(
      branches,
      context,
      graph,
      logsRoot,
      maxParallel,
      errorPolicy,
    );

    // For "ignore" error policy, filter out failed results for counting purposes
    const countableResults =
      errorPolicy === "ignore"
        ? results.filter((r) => r.status !== StageStatus.FAIL)
        : results;

    const successCount = countableResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    const failCount = countableResults.filter(
      (r) => r.status === StageStatus.FAIL,
    ).length;

    context.set("parallel.results", JSON.stringify(results));

    // Evaluate join policy
    if (joinPolicy === "first_success") {
      return successCount > 0
        ? successOutcome({
            notes: `${successCount}/${results.length} branches succeeded`,
          })
        : failOutcome("All branches failed");
    }

    if (joinPolicy === "k_of_n") {
      const k = parseInt(String(node.attrs["join_k"] ?? "1"), 10);
      return successCount >= k
        ? successOutcome({
            notes: `${successCount}/${results.length} branches succeeded (k=${k})`,
          })
        : failOutcome(
            `Only ${successCount}/${results.length} branches succeeded, need ${k}`,
          );
    }

    if (joinPolicy === "quorum") {
      const fraction = parseFloat(String(node.attrs["join_quorum"] ?? "0.5"));
      const required = Math.ceil(results.length * fraction);
      return successCount >= required
        ? successOutcome({
            notes: `${successCount}/${results.length} branches succeeded (quorum=${fraction}, required=${required})`,
          })
        : failOutcome(
            `Only ${successCount}/${results.length} branches succeeded, need ${required} (quorum=${fraction})`,
          );
    }

    // wait_all (default)
    if (failCount === 0) {
      return successOutcome({
        notes: `All ${results.length} branches succeeded`,
      });
    }
    return {
      status: StageStatus.PARTIAL_SUCCESS,
      notes: `${successCount}/${results.length} branches succeeded`,
    };
  }

  /**
   * Execute branches with bounded parallelism and error policy.
   *
   * - max_parallel controls how many branches execute concurrently (semaphore).
   * - error_policy="fail_fast" aborts remaining branches on first failure.
   * - error_policy="continue" (default) runs all branches regardless.
   * - error_policy="ignore" runs all branches; failures are still collected
   *   but will be excluded from join-policy counting.
   */
  private async executeBranches(
    branches: ReturnType<Graph["outgoingEdges"]>,
    context: Context,
    graph: Graph,
    logsRoot: string,
    maxParallel: number,
    errorPolicy: string,
  ): Promise<Outcome[]> {
    const results: Outcome[] = new Array(branches.length);
    let cancelled = false;

    // Semaphore for bounded parallelism
    let active = 0;
    const waitQueue: Array<() => void> = [];

    const acquireSlot = async (): Promise<void> => {
      if (active < maxParallel) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => {
        waitQueue.push(resolve);
      });
      active++;
    };

    const releaseSlot = (): void => {
      active--;
      if (waitQueue.length > 0) {
        const next = waitQueue.shift()!;
        next();
      }
    };

    const executeBranch = async (index: number): Promise<void> => {
      if (cancelled) {
        results[index] = failOutcome("Cancelled due to fail_fast policy");
        return;
      }

      await acquireSlot();

      if (cancelled) {
        releaseSlot();
        results[index] = failOutcome("Cancelled due to fail_fast policy");
        return;
      }

      try {
        const branchContext = context.clone();
        const outcome = await this.executeSubgraph!(
          branches[index]!.toNode,
          branchContext,
          graph,
          logsRoot,
        );
        results[index] = outcome;

        // Check fail_fast: if this branch failed, cancel remaining
        if (
          errorPolicy === "fail_fast" &&
          outcome.status === StageStatus.FAIL
        ) {
          cancelled = true;
        }
      } catch (err) {
        results[index] = failOutcome(String(err));
        if (errorPolicy === "fail_fast") {
          cancelled = true;
        }
      } finally {
        releaseSlot();
      }
    };

    // Launch all branches; the semaphore limits concurrency
    const promises = branches.map((_, index) => executeBranch(index));
    await Promise.all(promises);

    return results;
  }
}

/** Fan-in handler (spec §4.9): LLM evaluation when prompt is set, heuristic otherwise */
export class FanInHandler implements Handler {
  constructor(private backend: CodergenBackend | null = null) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
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

    // LLM-based evaluation: when the fan-in node has a prompt, call the
    // backend to rank candidates instead of using the heuristic.
    if (node.prompt && this.backend) {
      try {
        const evalPrompt =
          node.prompt +
          "\n\n## Candidates\n" +
          results
            .map(
              (r, i) =>
                `### Candidate ${i + 1}\n- Status: ${r.status}\n- Notes: ${r.notes ?? "(none)"}`,
            )
            .join("\n\n");

        const backendResult = await this.backend.run(node, evalPrompt, context);
        if (typeof backendResult === "object" && "status" in backendResult) {
          return backendResult as Outcome;
        }

        // Backend returned a string — treat it as notes on the selection
        return successOutcome({
          contextUpdates: {
            "parallel.fan_in.best_outcome": StageStatus.SUCCESS,
            "parallel.fan_in.llm_evaluation": String(backendResult),
          },
          notes: `LLM evaluation: ${String(backendResult).slice(0, 200)}`,
        });
      } catch (err) {
        return failOutcome(`Fan-in LLM evaluation failed: ${String(err)}`);
      }
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

/** Tool handler: executes shell commands with optional pre/post hooks (spec §9.7) */
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

    const preHook = node.attrs["pre_hook"] as string | undefined;
    const postHook = node.attrs["post_hook"] as string | undefined;
    const timeout = node.timeout ?? 30000;

    try {
      const { execSync } = await import("node:child_process");
      const execOpts = {
        timeout,
        encoding: "utf-8" as const,
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      };

      const notes: string[] = [];

      // Run pre_hook if specified; failure aborts the tool
      if (preHook) {
        try {
          const preOut = execSync(preHook, execOpts);
          notes.push(`pre_hook output: ${preOut.trim()}`);
        } catch (preErr) {
          return failOutcome(`pre_hook failed: ${String(preErr)}`, {
            notes: `pre_hook command: ${preHook}`,
          });
        }
      }

      // Run the main tool_command
      const result = execSync(command, execOpts);
      notes.push(`Tool completed: ${command}`);

      // Run post_hook if specified; failure is noted but tool still succeeds
      if (postHook) {
        try {
          const postOut = execSync(postHook, execOpts);
          notes.push(`post_hook output: ${postOut.trim()}`);
        } catch (postErr) {
          notes.push(`post_hook failed: ${String(postErr)}`);
        }
      }

      return successOutcome({
        contextUpdates: { "tool.output": result },
        notes: notes.join("\n"),
      });
    } catch (err) {
      return failOutcome(String(err));
    }
  }
}

/** Manager loop handler — implements the full observe/steer cycle per spec §4.11 */
export class ManagerLoopHandler implements Handler {
  private observer?: ManagerObserver;
  private lastSteerTime = 0;

  /** Wire an observer for the observe/steer cycle (analogous to ParallelHandler.setSubgraphExecutor) */
  setObserver(observer: ManagerObserver): void {
    this.observer = observer;
  }

  async execute(
    node: GraphNode,
    context: Context,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const maxCycles = parseInt(String(node.attrs["manager.max_cycles"] ?? "1000"), 10);
    const pollIntervalStr = String(node.attrs["manager.poll_interval"] ?? "45s");
    let pollIntervalMs: number;
    try {
      pollIntervalMs = parseDuration(pollIntervalStr);
    } catch {
      pollIntervalMs = 45_000;
    }
    const stopCondition = String(node.attrs["manager.stop_condition"] ?? "");
    const actionsStr = String(node.attrs["manager.actions"] ?? "observe,wait");
    const actions = new Set(actionsStr.split(",").map((a) => a.trim()).filter(Boolean));
    const steerCooldownMs = parseInt(String(node.attrs["manager.steer_cooldown_ms"] ?? String(pollIntervalMs)), 10);

    if (!this.observer) {
      // No observer wired: fall back to simple success (backward-compatible)
      return successOutcome({
        notes: `Manager loop completed (max_cycles=${maxCycles}, no observer)`,
      });
    }

    // Reset steer timer for this execution
    this.lastSteerTime = 0;

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      context.set("manager.current_cycle", cycle);

      // 1. Observe
      if (actions.has("observe")) {
        const observeResult = await this.observer.observe(context);

        // Write telemetry into context
        context.set("stack.child.status", observeResult.childStatus);
        if (observeResult.childOutcome !== undefined) {
          context.set("stack.child.outcome", observeResult.childOutcome);
        }
        if (observeResult.telemetry) {
          for (const [key, value] of Object.entries(observeResult.telemetry)) {
            context.set(`stack.child.telemetry.${key}`, value);
          }
        }
      }

      // 2. Steer (with cooldown)
      if (actions.has("steer") && this.steerCooldownElapsed(steerCooldownMs)) {
        await this.observer.steer(context, node);
        this.lastSteerTime = Date.now();
      }

      // 3. Evaluate child status
      const childStatus = context.getString("stack.child.status");
      if (childStatus === "completed" || childStatus === "failed") {
        const childOutcome = context.getString("stack.child.outcome");
        if (childOutcome === "success") {
          return successOutcome({
            notes: `Child completed successfully at cycle ${cycle}`,
            contextUpdates: { "manager.final_cycle": cycle },
          });
        }
        if (childStatus === "failed") {
          return failOutcome(`Child failed at cycle ${cycle}`, {
            notes: `Child outcome: ${childOutcome}`,
            contextUpdates: { "manager.final_cycle": cycle },
          });
        }
      }

      // 4. Evaluate stop condition
      if (stopCondition) {
        // We pass a synthetic "current" outcome for the condition evaluator
        const currentOutcome: Outcome = { status: StageStatus.SUCCESS };
        if (evaluateCondition(stopCondition, currentOutcome, context)) {
          return successOutcome({
            notes: `Stop condition satisfied at cycle ${cycle}`,
            contextUpdates: { "manager.final_cycle": cycle },
          });
        }
      }

      // 5. Wait
      if (actions.has("wait") && cycle < maxCycles) {
        await sleep(pollIntervalMs);
      }
    }

    return failOutcome("Max cycles exceeded", {
      notes: `Manager loop exhausted ${maxCycles} cycles`,
      contextUpdates: { "manager.final_cycle": maxCycles },
    });
  }

  private steerCooldownElapsed(cooldownMs: number): boolean {
    if (this.lastSteerTime === 0) return true;
    return Date.now() - this.lastSteerTime >= cooldownMs;
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
 * Synthesize a preamble from a fidelity-filtered context snapshot (spec §9.2).
 * Converts key-value pairs into a readable text block that gives the LLM
 * enough context to continue work without full conversation history.
 */
function synthesizePreamble(snapshot: Record<string, unknown>): string {
  const entries = Object.entries(snapshot).filter(
    ([key]) => !key.startsWith("internal."),
  );
  if (entries.length === 0) return "";

  const lines = entries.map(([key, value]) => {
    const v = value === "" ? "(empty)" : String(value);
    return `- ${key}: ${v}`;
  });
  return "## Context from previous stages\n" + lines.join("\n");
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
