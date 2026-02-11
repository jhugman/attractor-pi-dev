#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import {
  preparePipeline,
  PipelineRunner,
  Severity,
  ConsoleInterviewer,
  AutoApproveInterviewer,
  createServer,
  type PipelineEvent,
  type CodergenBackend,
} from "@attractor/core";
import { PiAgentCodergenBackend } from "@attractor/backend-pi-dev";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  if (command === "run") {
    await runCommand(args.slice(1));
  } else if (command === "validate") {
    validateCommand(args.slice(1));
  } else if (command === "serve") {
    await serveCommand(args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
attractor - DOT-based pipeline runner

Usage:
  attractor run <file.dot> [options]
  attractor validate <file.dot>
  attractor serve [options]

Commands:
  run        Execute a pipeline from a DOT file
  validate   Check a DOT file for errors
  serve      Start HTTP server for web-based pipeline management

Options (run):
  --simulate         Run in simulation mode (no LLM calls)
  --auto-approve     Auto-approve all human gates
  --logs-dir <path>  Output directory for logs (default: .attractor-runs/<timestamp>)
  --provider <name>  LLM provider (default: anthropic)
  --model <id>       LLM model ID (default: claude-sonnet-4-5-20250929)
  --set <key=value>  Set a pipeline variable (repeatable)
  --verbose          Show detailed event output

Options (serve):
  --port <number>    Port to listen on (default: 3000)
  --host <addr>      Host to bind to (default: 127.0.0.1)

General:
  --help, -h         Show this help
`);
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function runCommand(args: string[]) {
  // Find DOT file: first positional arg (skip values that follow --flags)
  const flagsWithValues = new Set(["--logs-dir", "--provider", "--model", "--set"]);
  let dotFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      if (flagsWithValues.has(args[i]!)) i++; // skip the flag's value
      continue;
    }
    dotFile = args[i];
    break;
  }
  const simulate = args.includes("--simulate");
  const autoApprove = args.includes("--auto-approve");
  const verbose = args.includes("--verbose");

  const logsDir = getArgValue(args, "--logs-dir");
  const provider = getArgValue(args, "--provider");
  const model = getArgValue(args, "--model");

  // Parse --set key=value flags (repeatable)
  const variables: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set" && args[i + 1]) {
      const pair = args[i + 1]!;
      const eqIdx = pair.indexOf("=");
      if (eqIdx >= 0) {
        variables[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
      } else {
        console.error(`Error: --set requires key=value format, got: ${pair}`);
        process.exit(1);
      }
      i++; // skip the value
    }
  }

  if (!dotFile) {
    console.error("Error: No DOT file specified");
    process.exit(1);
  }

  const filePath = path.resolve(dotFile);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, "utf-8");

  // Parse and validate
  let graph;
  try {
    const result = preparePipeline(source, { variables, dotFilePath: filePath });
    graph = result.graph;
    const warnings = result.diagnostics.filter((d) => d.severity === Severity.WARNING);
    for (const w of warnings) {
      console.warn(`  [WARN] [${w.rule}] ${w.message}`);
    }
  } catch (err) {
    console.error(`Validation failed:\n${err}`);
    process.exit(1);
  }

  console.log(`Pipeline: ${graph.id}`);
  console.log(`Goal: ${graph.attrs.goal || "(none)"}`);
  console.log(`Nodes: ${graph.nodes.size}`);
  console.log(`Edges: ${graph.edges.length}`);
  if (simulate) console.log("Mode: simulation");
  console.log("---");

  // Build runner
  const logsRoot = logsDir ?? path.join(process.cwd(), ".attractor-runs", Date.now().toString());
  const interviewer = autoApprove
    ? new AutoApproveInterviewer()
    : new ConsoleInterviewer();

  let backend: CodergenBackend | null;
  if (simulate) {
    backend = null;
  } else {
    backend = new PiAgentCodergenBackend({
      cwd: path.dirname(filePath),
      ...(provider && { defaultProvider: provider }),
      ...(model && { defaultModel: model }),
      onAgentEvent: (event) => {
        if (verbose) {
          console.log(`  [agent] ${event.type}`);
        }
      },
    });
  }

  const runner = new PipelineRunner({
    backend,
    interviewer,
    logsRoot,
    onEvent: (event) => {
      printEvent(event, verbose);
    },
  });

  try {
    const result = await runner.run(graph);
    console.log("\n---");
    console.log(`Result: ${result.outcome.status}`);
    console.log(`Completed: ${result.completedNodes.join(" -> ")}`);
    console.log(`Logs: ${logsRoot}`);

    if (result.outcome.status === "fail") {
      console.error(`Failure: ${result.outcome.failureReason}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Pipeline execution error: ${err}`);
    process.exit(1);
  } finally {
    if (backend && "dispose" in backend) {
      await (backend as PiAgentCodergenBackend).dispose();
    }
  }
}

function validateCommand(args: string[]) {
  const dotFile = args.find((a) => !a.startsWith("--"));
  if (!dotFile) {
    console.error("Error: No DOT file specified");
    process.exit(1);
  }

  const filePath = path.resolve(dotFile);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, "utf-8");

  try {
    const result = preparePipeline(source, { dotFilePath: filePath });
    const errors = result.diagnostics.filter((d) => d.severity === Severity.ERROR);
    const warnings = result.diagnostics.filter((d) => d.severity === Severity.WARNING);

    if (errors.length > 0) {
      console.error("ERRORS:");
      for (const e of errors) {
        console.error(`  [${e.rule}] ${e.message}`);
      }
    }
    if (warnings.length > 0) {
      console.warn("WARNINGS:");
      for (const w of warnings) {
        console.warn(`  [${w.rule}] ${w.message}`);
      }
    }

    if (errors.length === 0) {
      console.log(`Valid pipeline: ${result.graph.id} (${result.graph.nodes.size} nodes, ${result.graph.edges.length} edges)`);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Validation failed: ${err}`);
    process.exit(1);
  }
}

async function serveCommand(args: string[]) {
  const port = Number(getArgValue(args, "--port") ?? "3000");
  const host = getArgValue(args, "--host") ?? "127.0.0.1";

  const server = createServer();

  server.listen(port, host, () => {
    console.log(`Attractor HTTP server listening on http://${host}:${port}`);
    console.log("Endpoints:");
    console.log("  POST /run          - Start a pipeline (JSON body: { dotSource })");
    console.log("  GET  /status/:id   - Get run status");
    console.log("  POST /answer/:id   - Submit human-in-the-loop answer");
    console.log("  GET  /events/:id   - SSE event stream");
  });

  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      server.close(() => resolve());
    });
    process.on("SIGTERM", () => {
      console.log("\nShutting down...");
      server.close(() => resolve());
    });
  });
}

function printEvent(event: PipelineEvent, verbose: boolean) {
  const ts = new Date().toLocaleTimeString();
  switch (event.type) {
    case "pipeline_started":
      console.log(`[${ts}] Pipeline started: ${event.name}`);
      break;
    case "pipeline_completed":
      console.log(`[${ts}] Pipeline completed in ${event.durationMs}ms`);
      break;
    case "pipeline_failed":
      console.error(`[${ts}] Pipeline failed: ${event.error}`);
      break;
    case "stage_started":
      console.log(`[${ts}] Stage ${event.index}: ${event.name}`);
      break;
    case "stage_completed":
      if (verbose) console.log(`[${ts}]   completed (${event.durationMs}ms)`);
      break;
    case "stage_retrying":
      console.log(
        `[${ts}]   retrying (attempt ${event.attempt}, delay ${event.delayMs}ms)`,
      );
      break;
    case "stage_failed":
      console.error(`[${ts}]   failed: ${event.error}`);
      break;
    case "checkpoint_saved":
      if (verbose) console.log(`[${ts}]   checkpoint saved`);
      break;
    case "interview_started":
      console.log(`[${ts}] Human gate: ${event.question}`);
      break;
    default:
      if (verbose) console.log(`[${ts}] ${event.type}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
