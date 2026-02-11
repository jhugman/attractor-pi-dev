/**
 * HTTP server mode for Attractor pipeline runner.
 *
 * Provides REST endpoints for web-based pipeline management (spec §9.5):
 *   POST   /pipelines                              - Start a pipeline
 *   GET    /pipelines/{id}                          - Get run status
 *   POST   /pipelines/{id}/cancel                   - Cancel a running pipeline
 *   GET    /pipelines/{id}/events                   - SSE event stream
 *   GET    /pipelines/{id}/graph                    - Get graph visualization
 *   GET    /pipelines/{id}/checkpoint               - Get checkpoint state
 *   GET    /pipelines/{id}/context                  - Get context key-value store
 *   POST   /pipelines/{id}/questions/{qid}/answer   - Submit human-in-the-loop answer
 *
 * Uses only Node.js built-in modules (http, child_process) - no external dependencies.
 * Per spec section 9.5.
 */
import * as http from "node:http";
import { spawn } from "node:child_process";
import { preparePipeline } from "../engine/pipeline.js";
import { PipelineRunner } from "../engine/runner.js";
import type { RunConfig, RunResult } from "../engine/runner.js";
import type { PipelineEvent, EventListener } from "../events/index.js";
import { CallbackInterviewer } from "../handlers/interviewers.js";
import type { Question, Answer, CodergenBackend } from "../handlers/types.js";
import { AnswerValue } from "../handlers/types.js";
import type { Graph } from "../model/graph.js";

/** Status of a pipeline run */
export type RunStatus = "running" | "completed" | "failed" | "waiting_for_answer" | "cancelled";

/** Pending question awaiting a human answer */
interface PendingQuestion {
  question: Question;
  resolve: (answer: Answer) => void;
}

/** State for an active pipeline run */
export interface RunState {
  runId: string;
  status: RunStatus;
  graph: Graph;
  dotSource: string;
  runner: PipelineRunner;
  result: RunResult | null;
  error: string | null;
  completedNodes: string[];
  currentNode: string | null;
  context: Record<string, unknown>;
  events: PipelineEvent[];
  eventListeners: Set<EventListener>;
  pendingQuestion: PendingQuestion | null;
  cancelled: boolean;
}

/** Configuration for createServer */
export interface ServerConfig {
  backend?: CodergenBackend | null;
  logsRoot?: string;
}

/**
 * Create an HTTP server for pipeline management.
 * Returns the server instance (not yet listening).
 */
export function createServer(serverConfig: ServerConfig = {}): http.Server {
  const runs = new Map<string, RunState>();
  let nextRunId = 1;

  function generateRunId(): string {
    return `run-${nextRunId++}`;
  }

  /** Read the request body as a string */
  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /** Send a JSON response */
  function sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown,
  ): void {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  /** Send an error response */
  function sendError(
    res: http.ServerResponse,
    statusCode: number,
    message: string,
  ): void {
    sendJson(res, statusCode, { error: message });
  }

  /** Parse URL path and extract segments */
  function parsePath(url: string): string[] {
    const pathname = new URL(url, "http://localhost").pathname;
    return pathname.split("/").filter(Boolean);
  }

  /** POST /pipelines - Start a pipeline */
  async function handlePostPipelines(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, "Failed to read request body");
      return;
    }

    let parsed: { dotSource?: string; config?: Record<string, unknown> };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, 400, "Invalid JSON");
      return;
    }

    if (!parsed.dotSource || typeof parsed.dotSource !== "string") {
      sendError(res, 400, "Missing or invalid dotSource");
      return;
    }

    // Parse and validate the DOT source
    let graph: Graph;
    try {
      const result = preparePipeline(parsed.dotSource);
      graph = result.graph;
    } catch (err) {
      sendError(res, 400, `Invalid DOT source: ${err}`);
      return;
    }

    const runId = generateRunId();

    // Create run state
    const runState: RunState = {
      runId,
      status: "running",
      graph,
      dotSource: parsed.dotSource,
      runner: null as unknown as PipelineRunner,
      result: null,
      error: null,
      completedNodes: [],
      currentNode: null,
      context: {},
      events: [],
      eventListeners: new Set(),
      pendingQuestion: null,
      cancelled: false,
    };

    // Create a callback-based interviewer that queues questions
    const interviewer = new CallbackInterviewer(
      (question: Question): Promise<Answer> => {
        return new Promise<Answer>((resolve) => {
          runState.pendingQuestion = { question, resolve };
          runState.status = "waiting_for_answer";
        });
      },
    );

    // Create the pipeline runner
    const runConfig: RunConfig = {
      backend: serverConfig.backend ?? null,
      interviewer,
      logsRoot: serverConfig.logsRoot,
      onEvent: (event: PipelineEvent) => {
        runState.events.push(event);

        // Track current node and completed nodes from events
        if (event.type === "stage_started") {
          runState.currentNode = event.name;
        }
        if (event.type === "stage_completed") {
          if (!runState.completedNodes.includes(event.name)) {
            runState.completedNodes.push(event.name);
          }
        }

        // Notify SSE listeners
        for (const listener of runState.eventListeners) {
          listener(event);
        }
      },
    };

    const runner = new PipelineRunner(runConfig);
    runState.runner = runner;
    runs.set(runId, runState);

    // Start pipeline execution in the background
    runner
      .run(graph)
      .then((result: RunResult) => {
        // If the pipeline was cancelled, don't overwrite the cancelled status
        if (runState.cancelled) return;
        runState.result = result;
        runState.status =
          result.outcome.status === "fail" ? "failed" : "completed";
        runState.completedNodes = result.completedNodes;
        runState.context = result.context.snapshot();
      })
      .catch((err: unknown) => {
        // If the pipeline was cancelled, don't overwrite the cancelled status
        if (runState.cancelled) return;
        runState.status = "failed";
        runState.error = String(err);
      });

    sendJson(res, 201, { runId });
  }

  /** GET /pipelines/{id} - Get run status */
  function handleGetStatus(
    res: http.ServerResponse,
    runId: string,
  ): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    const response: Record<string, unknown> = {
      runId: run.runId,
      status: run.status,
      currentNode: run.currentNode,
      completedNodes: run.completedNodes,
      context: run.context,
    };

    if (run.status === "waiting_for_answer" && run.pendingQuestion) {
      response.pendingQuestion = {
        text: run.pendingQuestion.question.text,
        type: run.pendingQuestion.question.type,
        options: run.pendingQuestion.question.options,
        stage: run.pendingQuestion.question.stage,
      };
    }

    if (run.result) {
      response.outcome = run.result.outcome;
      response.context = run.result.context.snapshot();
    }

    if (run.error) {
      response.error = run.error;
    }

    sendJson(res, 200, response);
  }

  /** POST /pipelines/{id}/cancel - Cancel a running pipeline */
  function handlePostCancel(
    res: http.ServerResponse,
    runId: string,
  ): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      sendError(res, 409, `Pipeline is already ${run.status}`);
      return;
    }

    // Mark as cancelled
    run.cancelled = true;
    run.status = "cancelled";
    run.error = "Pipeline cancelled by user";

    // If there's a pending question, resolve it to unblock the runner
    if (run.pendingQuestion) {
      const pending = run.pendingQuestion;
      run.pendingQuestion = null;
      pending.resolve({ value: AnswerValue.SKIPPED });
    }

    sendJson(res, 200, { runId, status: "cancelled" });
  }

  /** POST /pipelines/{id}/questions/{qid}/answer - Submit a human-in-the-loop answer */
  async function handlePostAnswer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runId: string,
    _questionId: string,
  ): Promise<void> {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    if (!run.pendingQuestion) {
      sendError(res, 409, "No pending question for this run");
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, "Failed to read request body");
      return;
    }

    let parsed: { value?: string; text?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, 400, "Invalid JSON");
      return;
    }

    if (parsed.value === undefined) {
      sendError(res, 400, "Missing answer value");
      return;
    }

    // Resolve the pending question
    const answer: Answer = {
      value: parsed.value,
      ...(parsed.text !== undefined && { text: parsed.text }),
    };

    const pending = run.pendingQuestion;
    run.pendingQuestion = null;
    run.status = "running";
    pending.resolve(answer);

    sendJson(res, 200, { accepted: true });
  }

  /** GET /pipelines/{id}/events - SSE event stream */
  function handleGetEvents(
    res: http.ServerResponse,
    runId: string,
  ): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send any existing events as a replay
    for (const event of run.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Subscribe to new events
    const listener: EventListener = (event: PipelineEvent) => {
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    run.eventListeners.add(listener);

    // Check if the run is already finished
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
      res.end();
      return;
    }

    // Clean up on client disconnect
    res.on("close", () => {
      run.eventListeners.delete(listener);
    });
  }

  /** GET /pipelines/{id}/checkpoint - Get current checkpoint state */
  function handleGetCheckpoint(
    res: http.ServerResponse,
    runId: string,
  ): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    const checkpoint = {
      runId: run.runId,
      status: run.status,
      currentNode: run.currentNode,
      completedNodes: run.completedNodes,
    };

    sendJson(res, 200, checkpoint);
  }

  /** GET /pipelines/{id}/context - Get current context key-value store */
  function handleGetContext(
    res: http.ServerResponse,
    runId: string,
  ): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    // If the result is available, use its context snapshot; otherwise use tracked context
    const context = run.result
      ? run.result.context.snapshot()
      : run.context;

    sendJson(res, 200, { runId: run.runId, context });
  }

  /** GET /pipelines/{id}/graph - Get graph visualization (SVG or DOT source) */
  function handleGetGraph(
    res: http.ServerResponse,
    runId: string,
  ): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    const dotSource = run.dotSource;

    // Try to render SVG via the `dot` command (from Graphviz)
    try {
      const proc = spawn("dot", ["-Tsvg"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });

      const chunks: Buffer[] = [];

      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

      proc.on("error", () => {
        // `dot` command not found — return raw DOT source
        if (!res.headersSent) {
          const body = dotSource;
          res.writeHead(200, {
            "Content-Type": "text/vnd.graphviz",
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
        }
      });

      proc.on("close", (code) => {
        if (res.headersSent) return;

        if (code !== 0) {
          // dot failed — return raw DOT source
          const body = dotSource;
          res.writeHead(200, {
            "Content-Type": "text/vnd.graphviz",
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }

        const svg = Buffer.concat(chunks).toString("utf-8");
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": Buffer.byteLength(svg),
        });
        res.end(svg);
      });

      proc.stdin.write(dotSource);
      proc.stdin.end();
    } catch {
      // Fallback: return raw DOT source
      if (!res.headersSent) {
        const body = dotSource;
        res.writeHead(200, {
          "Content-Type": "text/vnd.graphviz",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      }
    }
  }

  /** Main request router */
  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method?.toUpperCase() ?? "GET";
    const segments = parsePath(req.url ?? "/");

    try {
      // All routes start with /pipelines
      if (segments[0] !== "pipelines") {
        sendError(res, 404, "Not found");
        return;
      }

      // POST /pipelines - Start a pipeline
      if (method === "POST" && segments.length === 1) {
        await handlePostPipelines(req, res);
        return;
      }

      // Routes that require a pipeline ID: /pipelines/{id}/...
      if (segments.length >= 2) {
        const runId = segments[1]!;

        // GET /pipelines/{id} - Get status
        if (method === "GET" && segments.length === 2) {
          handleGetStatus(res, runId);
          return;
        }

        // POST /pipelines/{id}/cancel - Cancel pipeline
        if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
          handlePostCancel(res, runId);
          return;
        }

        // GET /pipelines/{id}/events - SSE event stream
        if (method === "GET" && segments.length === 3 && segments[2] === "events") {
          handleGetEvents(res, runId);
          return;
        }

        // GET /pipelines/{id}/graph - Graph visualization
        if (method === "GET" && segments.length === 3 && segments[2] === "graph") {
          handleGetGraph(res, runId);
          return;
        }

        // GET /pipelines/{id}/checkpoint - Checkpoint state
        if (method === "GET" && segments.length === 3 && segments[2] === "checkpoint") {
          handleGetCheckpoint(res, runId);
          return;
        }

        // GET /pipelines/{id}/context - Context key-value store
        if (method === "GET" && segments.length === 3 && segments[2] === "context") {
          handleGetContext(res, runId);
          return;
        }

        // POST /pipelines/{id}/questions/{qid}/answer - Submit answer
        if (
          method === "POST" &&
          segments.length === 5 &&
          segments[2] === "questions" &&
          segments[4] === "answer"
        ) {
          await handlePostAnswer(req, res, runId, segments[3]!);
          return;
        }
      }

      // Unknown route
      sendError(res, 404, "Not found");
    } catch (err) {
      sendError(res, 500, `Internal server error: ${err}`);
    }
  }

  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          sendError(res, 500, `Internal server error: ${err}`);
        }
      });
    },
  );

  // Attach the runs map to the server for testing access
  (server as HttpPipelineServer).runs = runs;

  return server;
}

/** Extended server type with runs map accessible for testing */
export interface HttpPipelineServer extends http.Server {
  runs: Map<string, RunState>;
}
