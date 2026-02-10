#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import {
  preparePipeline,
  PipelineRunner,
  Severity,
  ConsoleInterviewer,
  AutoApproveInterviewer,
  type PipelineEvent,
} from "@attractor/core";

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

Options:
  --simulate         Run in simulation mode (no LLM calls)
  --auto-approve     Auto-approve all human gates
  --logs-dir <path>  Output directory for logs (default: .attractor-runs/<timestamp>)
  --verbose          Show detailed event output
  --help, -h         Show this help
`);
}

async function runCommand(args: string[]) {
  const dotFile = args.find((a) => !a.startsWith("--"));
  const simulate = args.includes("--simulate");
  const autoApprove = args.includes("--auto-approve");
  const verbose = args.includes("--verbose");

  const logsDirIdx = args.indexOf("--logs-dir");
  const logsDir = logsDirIdx >= 0 ? args[logsDirIdx + 1] : undefined;

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
    const result = preparePipeline(source);
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

  const runner = new PipelineRunner({
    backend: simulate ? null : undefined,
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
    const result = preparePipeline(source);
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
