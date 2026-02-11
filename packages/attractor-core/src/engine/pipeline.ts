import { parseDot } from "../parser/parser.js";
import { buildGraph } from "../model/builder.js";
import { applyTransforms, type Transform } from "../transforms/index.js";
import { validate, validateOrRaise, type Diagnostic } from "../validation/index.js";
import type { Graph } from "../model/graph.js";

export interface PrepareOptions {
  /** Custom transforms (replaces defaults if provided) */
  transforms?: Transform[];
  /** Variable overrides from CLI --set flags */
  variables?: Record<string, string>;
  /** Absolute path to the DOT file (used for prompt resolution) */
  dotFilePath?: string;
}

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
  transformsOrOptions?: Transform[] | PrepareOptions,
): PrepareResult {
  // Normalize arguments
  const opts: PrepareOptions = Array.isArray(transformsOrOptions)
    ? { transforms: transformsOrOptions }
    : transformsOrOptions ?? {};

  // 1. Parse
  const ast = parseDot(dotSource);

  // 2. Build graph model
  let graph = buildGraph(ast);

  // 3. Apply transforms
  graph = applyTransforms(graph, opts.transforms, opts.variables, opts.dotFilePath);

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
