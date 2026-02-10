import { parseDot } from "../parser/parser.js";
import { buildGraph } from "../model/builder.js";
import { applyTransforms, type Transform } from "../transforms/index.js";
import { validate, validateOrRaise, type Diagnostic } from "../validation/index.js";
import type { Graph } from "../model/graph.js";

export interface PrepareResult {
  graph: Graph;
  diagnostics: Diagnostic[];
}

/**
 * Parse, transform, and validate a DOT source string.
 * This is the primary entry point for preparing a pipeline.
 */
export function preparePipeline(
  dotSource: string,
  transforms?: Transform[],
): PrepareResult {
  // 1. Parse
  const ast = parseDot(dotSource);

  // 2. Build graph model
  let graph = buildGraph(ast);

  // 3. Apply transforms
  graph = applyTransforms(graph, transforms);

  // 4. Validate
  const diagnostics = validateOrRaise(graph);

  return { graph, diagnostics };
}

/**
 * Parse and build without validation (for testing/inspection).
 */
export function parseAndBuild(dotSource: string): Graph {
  const ast = parseDot(dotSource);
  return buildGraph(ast);
}
