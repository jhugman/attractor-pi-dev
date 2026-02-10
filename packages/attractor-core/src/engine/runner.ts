import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphNode } from "../model/graph.js";
import { Context } from "../state/context.js";
import { Checkpoint } from "../state/checkpoint.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, failOutcome } from "../state/types.js";
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
      const checkpoint = new Checkpoint({
        currentNode: node.id,
        completedNodes: [...completedNodes],
        context: context.snapshot(),
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

      // Step 7: Handle loop_restart
      if (nextEdge.loopRestart) {
        // Simplified: just continue to the target
      }

      // Step 8: Advance to next node
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
