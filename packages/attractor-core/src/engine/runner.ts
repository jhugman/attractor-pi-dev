import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphEdge, GraphNode } from "../model/graph.js";
import { Context } from "../state/context.js";
import { Checkpoint } from "../state/checkpoint.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, failOutcome } from "../state/types.js";
import { resolveEffectiveFidelity, resolveThreadKey } from "../state/fidelity.js";
import { EventEmitter, type PipelineEvent } from "../events/index.js";
import { HandlerRegistry } from "../handlers/registry.js";
import type { CodergenBackend, Interviewer } from "../handlers/types.js";
import { selectEdge } from "./edge-selection.js";
import { buildRetryPolicy, delayForAttempt, sleep } from "./retry.js";

export interface RunConfig {
  backend?: CodergenBackend | null;
  interviewer?: Interviewer;
  logsRoot?: string;
  resumeFrom?: string;
  onEvent?: (event: PipelineEvent) => void;
}

export interface RunResult {
  outcome: Outcome;
  completedNodes: string[];
  context: Context;
}

/** The core pipeline execution engine */
export class PipelineRunner {
  private registry: HandlerRegistry;
  private emitter = new EventEmitter();

  constructor(private config: RunConfig = {}) {
    this.registry = new HandlerRegistry({
      backend: config.backend ?? null,
      interviewer: config.interviewer,
    });

    if (config.onEvent) {
      this.emitter.on(config.onEvent);
    }

    // Wire the subgraph executor into the ParallelHandler
    this.wireParallelHandler();
  }

  /** Wire the subgraph executor callback into the ParallelHandler */
  private wireParallelHandler(): void {
    const parallelHandler = this.registry.getParallelHandler();
    if (parallelHandler) {
      parallelHandler.setSubgraphExecutor(
        (startNodeId, context, graph, logsRoot) =>
          this.executeSubgraph(startNodeId, context, graph, logsRoot),
      );
    }
  }

  /**
   * Execute a subgraph starting from a given node, walking through the graph
   * until a terminal node or dead-end is reached. Used by ParallelHandler
   * to run each branch concurrently with an isolated context.
   */
  private async executeSubgraph(
    startNodeId: string,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    let currentNode = graph.getNode(startNodeId);
    let lastOutcome: Outcome = { status: StageStatus.SUCCESS };
    let subgraphIncomingEdge: GraphEdge | null = null;
    let subgraphPreviousNodeId = "";

    while (true) {
      // Check for terminal node or fan-in convergence point
      if (graph.isTerminal(currentNode) || this.isSubgraphBoundary(currentNode, graph)) {
        break;
      }

      // Set incoming edge fidelity context for handlers
      context.set("internal.incoming_edge_fidelity", subgraphIncomingEdge?.fidelity ?? "");
      context.set("internal.incoming_edge_thread_id", subgraphIncomingEdge?.threadId ?? "");

      // Execute the handler for this node
      const handler = this.registry.resolve(currentNode);
      try {
        lastOutcome = await handler.execute(currentNode, context, graph, logsRoot);
      } catch (err) {
        return failOutcome(String(err));
      }

      // Apply context updates
      if (lastOutcome.contextUpdates) {
        context.applyUpdates(lastOutcome.contextUpdates as Record<string, unknown>);
      }
      context.set("outcome", lastOutcome.status);
      if (lastOutcome.preferredLabel) {
        context.set("preferred_label", lastOutcome.preferredLabel);
      }

      // If the handler failed, stop the subgraph execution
      if (lastOutcome.status === StageStatus.FAIL) {
        return lastOutcome;
      }

      // Select the next edge
      const outgoing = graph.outgoingEdges(currentNode.id);
      const nextEdge = selectEdge(outgoing, lastOutcome, context);

      if (!nextEdge) {
        // No more edges: subgraph walk is done
        break;
      }

      subgraphPreviousNodeId = currentNode.id;
      subgraphIncomingEdge = nextEdge;
      currentNode = graph.getNode(nextEdge.toNode);
    }

    return lastOutcome;
  }

  /**
   * Check if a node is a subgraph boundary where branch execution should stop.
   * Fan-in nodes (parallel.fan_in) are convergence points that should be
   * executed by the main pipeline loop, not within individual branches.
   */
  private isSubgraphBoundary(node: GraphNode, graph: Graph): boolean {
    const handlerType = graph.resolveHandlerType(node);
    return handlerType === "parallel.fan_in";
  }

  /** Register a custom handler */
  registerHandler(typeString: string, handler: import("../handlers/types.js").Handler): void {
    this.registry.register(typeString, handler);
  }

  /** Run a pipeline graph */
  async run(graph: Graph, overrideContext?: Context): Promise<RunResult> {
    const logsRoot = this.config.logsRoot ?? path.join(process.cwd(), ".attractor-runs", Date.now().toString());
    fs.mkdirSync(logsRoot, { recursive: true });

    // Write manifest
    const manifest = {
      name: graph.id,
      goal: graph.attrs.goal,
      startTime: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(logsRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    const context = overrideContext ?? new Context();
    const completedNodes: string[] = [];
    const nodeOutcomes = new Map<string, Outcome>();

    // Mirror graph attributes into context
    context.set("graph.goal", graph.attrs.goal);

    const startTime = Date.now();
    this.emitter.emit({
      type: "pipeline_started",
      name: graph.id,
      id: logsRoot,
      timestamp: new Date().toISOString(),
    });

    // Find start node
    const startNode = graph.findStartNode();
    if (!startNode) {
      const err = failOutcome("No start node found");
      this.emitter.emit({
        type: "pipeline_failed",
        error: "No start node found",
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
      return { outcome: err, completedNodes, context };
    }

    let currentNode: GraphNode = startNode;
    let lastOutcome: Outcome = { status: StageStatus.SUCCESS };
    let stageIndex = 0;
    let incomingEdge: GraphEdge | null = null;
    let previousNodeId = "";
    // Flag for resume fidelity degradation (spec §5.3 point 6):
    // When resuming, if the last completed node used full fidelity,
    // degrade the first resumed node to summary:high.
    let degradeNextFidelity = false;

    // Checkpoint resume: restore state from a previous run
    if (this.config.resumeFrom) {
      const resumeDir = this.config.resumeFrom;
      if (Checkpoint.exists(resumeDir)) {
        const cp = Checkpoint.load(resumeDir);

        // Restore context values from the checkpoint
        context.applyUpdates(cp.contextValues);

        // Restore completed nodes and mark them with SUCCESS outcomes
        for (const nodeId of cp.completedNodes) {
          completedNodes.push(nodeId);
          nodeOutcomes.set(nodeId, { status: StageStatus.SUCCESS });
        }

        // Restore retry counters into context
        for (const [nodeId, count] of Object.entries(cp.nodeRetries)) {
          context.set(`internal.retry_count.${nodeId}`, count);
        }

        // Determine the resume point: find the next node after the last completed node.
        // The checkpoint's currentNode is the last node that was completed.
        // We need to find the outgoing edge from it and advance there.
        const lastCompletedId = cp.currentNode;
        if (lastCompletedId && graph.nodes.has(lastCompletedId)) {
          const lastNode = graph.getNode(lastCompletedId);

          if (graph.isTerminal(lastNode)) {
            // The last completed node was a terminal; pipeline was already done
            // Just return success
            return { outcome: lastOutcome, completedNodes, context };
          }

          // Select the next edge from the last completed node using the checkpoint context
          const outgoing = graph.outgoingEdges(lastCompletedId);
          const nextEdge = selectEdge(outgoing, lastOutcome, context);

          if (nextEdge) {
            currentNode = graph.getNode(nextEdge.toNode);
            incomingEdge = nextEdge;
            previousNodeId = lastCompletedId;

            // Resume degradation (spec §5.3 point 6): if the last completed node
            // used full fidelity, degrade the first resumed node to summary:high
            const lastNodeFidelity = resolveEffectiveFidelity(
              "",
              lastNode.fidelity,
              graph.attrs.defaultFidelity,
            );
            if (lastNodeFidelity === "full") {
              degradeNextFidelity = true;
            }
          } else {
            // No outgoing edge from last completed; re-execute from last completed
            currentNode = lastNode;
            // Remove from completed so it gets re-executed
            const idx = completedNodes.lastIndexOf(lastCompletedId);
            if (idx >= 0) completedNodes.splice(idx, 1);
            nodeOutcomes.delete(lastCompletedId);
          }
        }

        stageIndex = completedNodes.length;

        this.emitter.emit({
          type: "checkpoint_resumed",
          resumedFromNode: cp.currentNode,
          skippedNodes: [...cp.completedNodes],
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Core execution loop
    while (true) {
      const node = currentNode;
      context.set("current_node", node.id);

      // Step 1: Check for terminal node
      if (graph.isTerminal(node)) {
        const [gateOk, failedGate] = this.checkGoalGates(graph, nodeOutcomes);
        if (!gateOk && failedGate) {
          const retryTarget = this.getRetryTarget(failedGate, graph);
          if (retryTarget) {
            currentNode = graph.getNode(retryTarget);
            continue;
          }
          lastOutcome = failOutcome("Goal gate unsatisfied and no retry target");
          break;
        }
        break;
      }

      // Step 1b: Set incoming edge fidelity and thread context for handlers.
      // This allows the CodergenHandler to read edge fidelity from context
      // for the §5.4 precedence chain.
      context.set("internal.incoming_edge_fidelity", incomingEdge?.fidelity ?? "");
      context.set("internal.incoming_edge_thread_id", incomingEdge?.threadId ?? "");

      // Resolve effective fidelity for this node (may be overridden by resume degradation)
      let effectiveFidelity = resolveEffectiveFidelity(
        incomingEdge?.fidelity ?? "",
        node.fidelity,
        graph.attrs.defaultFidelity,
      );

      // Resume degradation (spec §5.3 point 6): force summary:high on the first
      // node after resuming from a full-fidelity node
      if (degradeNextFidelity) {
        effectiveFidelity = "summary:high";
        context.set("internal.incoming_edge_fidelity", "summary:high");
        degradeNextFidelity = false;
      }

      // Thread resolution (spec §5.4): when fidelity is "full", determine thread key
      // for LLM session reuse.
      if (effectiveFidelity === "full") {
        const threadKey = resolveThreadKey({
          nodeThreadId: node.threadId,
          edgeThreadId: incomingEdge?.threadId ?? "",
          graphDefaultThread: String(graph.attrs["default_thread"] ?? ""),
          subgraphClass: node.classes.length > 0 ? node.classes[0]! : "",
          previousNodeId,
        });
        context.set("internal.thread_key", threadKey);
      }

      context.set("internal.effective_fidelity", effectiveFidelity);

      // Step 2: Execute node handler with retry
      const stageStart = Date.now();
      this.emitter.emit({
        type: "stage_started",
        name: node.id,
        index: stageIndex,
        timestamp: new Date().toISOString(),
      });

      const retryPolicy = buildRetryPolicy(node, graph);
      const outcome = await this.executeWithRetry(
        node,
        context,
        graph,
        logsRoot,
        retryPolicy,
        stageIndex,
      );

      const stageDuration = Date.now() - stageStart;
      this.emitter.emit({
        type: "stage_completed",
        name: node.id,
        index: stageIndex,
        durationMs: stageDuration,
        timestamp: new Date().toISOString(),
      });

      // Step 3: Record completion
      completedNodes.push(node.id);
      nodeOutcomes.set(node.id, outcome);
      lastOutcome = outcome;
      stageIndex++;

      // Step 4: Apply context updates
      if (outcome.contextUpdates) {
        context.applyUpdates(outcome.contextUpdates as Record<string, unknown>);
      }
      context.set("outcome", outcome.status);
      if (outcome.preferredLabel) {
        context.set("preferred_label", outcome.preferredLabel);
      }

      // Step 5: Save checkpoint
      const nodeRetries: Record<string, number> = {};
      const snap = context.snapshot();
      for (const [key, value] of Object.entries(snap)) {
        if (key.startsWith("internal.retry_count.")) {
          const nodeId = key.slice("internal.retry_count.".length);
          nodeRetries[nodeId] = Number(value);
        }
      }
      const checkpoint = new Checkpoint({
        currentNode: node.id,
        completedNodes: [...completedNodes],
        nodeRetries,
        context: snap,
      });
      checkpoint.save(logsRoot);
      this.emitter.emit({
        type: "checkpoint_saved",
        nodeId: node.id,
        timestamp: new Date().toISOString(),
      });

      // Step 6: Select next edge
      const outgoing = graph.outgoingEdges(node.id);
      const nextEdge = selectEdge(outgoing, outcome, context);

      if (!nextEdge) {
        if (outcome.status === StageStatus.FAIL) {
          lastOutcome = failOutcome("Stage failed with no outgoing fail edge");
        }
        break;
      }

      // Step 7: Handle loop_restart — reset retry counters so the
      //         target node (and downstream nodes) execute as a fresh loop iteration.
      if (nextEdge.loopRestart) {
        // Clear all internal retry counters stored in context
        const snapshot = context.snapshot();
        for (const key of Object.keys(snapshot)) {
          if (key.startsWith("internal.retry_count.")) {
            context.delete(key);
          }
        }

        // Remove the target node (and any nodes it can reach) from
        // nodeOutcomes so goal-gate checks see them as unvisited.
        const reachable = graph.reachableFrom(nextEdge.toNode);
        for (const nodeId of reachable) {
          nodeOutcomes.delete(nodeId);
        }

        this.emitter.emit({
          type: "loop_restarted",
          fromNode: node.id,
          toNode: nextEdge.toNode,
          timestamp: new Date().toISOString(),
        });
      }

      // Step 8: Advance to next node, tracking incoming edge for fidelity/thread resolution
      previousNodeId = node.id;
      incomingEdge = nextEdge;
      currentNode = graph.getNode(nextEdge.toNode);
    }

    const totalDuration = Date.now() - startTime;
    if (lastOutcome.status === StageStatus.SUCCESS || lastOutcome.status === StageStatus.PARTIAL_SUCCESS) {
      this.emitter.emit({
        type: "pipeline_completed",
        durationMs: totalDuration,
        artifactCount: completedNodes.length,
        timestamp: new Date().toISOString(),
      });
    } else {
      this.emitter.emit({
        type: "pipeline_failed",
        error: lastOutcome.failureReason ?? "Pipeline failed",
        durationMs: totalDuration,
        timestamp: new Date().toISOString(),
      });
    }

    return { outcome: lastOutcome, completedNodes, context };
  }

  private async executeWithRetry(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
    retryPolicy: RetryPolicy,
    stageIndex: number,
  ): Promise<Outcome> {
    const handler = this.registry.resolve(node);

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      try {
        const outcome = await handler.execute(node, context, graph, logsRoot);

        if (
          outcome.status === StageStatus.SUCCESS ||
          outcome.status === StageStatus.PARTIAL_SUCCESS
        ) {
          return outcome;
        }

        if (outcome.status === StageStatus.RETRY) {
          if (attempt < retryPolicy.maxAttempts) {
            const retryKey = `internal.retry_count.${node.id}`;
            context.set(retryKey, context.getNumber(retryKey) + 1);

            const delay = delayForAttempt(attempt, retryPolicy.backoff);
            this.emitter.emit({
              type: "stage_retrying",
              name: node.id,
              index: stageIndex,
              attempt,
              delayMs: delay,
              timestamp: new Date().toISOString(),
            });
            await sleep(delay);
            continue;
          }
          if (node.allowPartial) {
            return {
              status: StageStatus.PARTIAL_SUCCESS,
              notes: "retries exhausted, partial accepted",
            };
          }
          return failOutcome("max retries exceeded");
        }

        if (outcome.status === StageStatus.FAIL) {
          return outcome;
        }

        return outcome;
      } catch (err) {
        if (retryPolicy.shouldRetry(err as Error) && attempt < retryPolicy.maxAttempts) {
          const delay = delayForAttempt(attempt, retryPolicy.backoff);
          this.emitter.emit({
            type: "stage_retrying",
            name: node.id,
            index: stageIndex,
            attempt,
            delayMs: delay,
            timestamp: new Date().toISOString(),
          });
          await sleep(delay);
          continue;
        }
        return failOutcome(String(err));
      }
    }

    return failOutcome("max retries exceeded");
  }

  private checkGoalGates(
    graph: Graph,
    nodeOutcomes: Map<string, Outcome>,
  ): [boolean, GraphNode | null] {
    for (const [nodeId, outcome] of nodeOutcomes) {
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      if (node.goalGate) {
        if (
          outcome.status !== StageStatus.SUCCESS &&
          outcome.status !== StageStatus.PARTIAL_SUCCESS
        ) {
          return [false, node];
        }
      }
    }
    return [true, null];
  }

  private getRetryTarget(node: GraphNode, graph: Graph): string | null {
    if (node.retryTarget && graph.nodes.has(node.retryTarget)) {
      return node.retryTarget;
    }
    if (node.fallbackRetryTarget && graph.nodes.has(node.fallbackRetryTarget)) {
      return node.fallbackRetryTarget;
    }
    if (graph.attrs.retryTarget && graph.nodes.has(graph.attrs.retryTarget)) {
      return graph.attrs.retryTarget;
    }
    if (graph.attrs.fallbackRetryTarget && graph.nodes.has(graph.attrs.fallbackRetryTarget)) {
      return graph.attrs.fallbackRetryTarget;
    }
    return null;
  }

  /** Get the event emitter for subscribing to events */
  get events(): EventEmitter {
    return this.emitter;
  }
}

// Re-export RetryPolicy for the runner module
type RetryPolicy = import("./retry.js").RetryPolicy;
