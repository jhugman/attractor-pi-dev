import type { FidelityMode } from "../model/types.js";
import { VALID_FIDELITY_MODES } from "../model/types.js";

/** Default truncation limits per fidelity mode */
const TRUNCATE_LIMIT = 1000;
const SUMMARY_HIGH_LIMIT = 500;
const SUMMARY_MEDIUM_LIMIT = 100;

/**
 * Apply a fidelity mode to a context snapshot, filtering and transforming
 * the key-value pairs according to spec section 5.4.
 *
 * Fidelity modes control how much prior context is passed to the LLM backend:
 * - `full`:           return all context as-is (default)
 * - `truncate`:       truncate long string values to 1000 chars
 * - `compact`:        remove internal.* keys and truncate values to 1000 chars
 * - `summary:low`:    only include keys, values set to empty string
 * - `summary:medium`: include keys with values truncated to 100 chars
 * - `summary:high`:   include keys with values truncated to 500 chars
 */
export function applyFidelity(
  snapshot: Record<string, unknown>,
  mode: FidelityMode | string,
): Record<string, unknown> {
  // Unrecognised or empty mode defaults to "full"
  if (!mode || !VALID_FIDELITY_MODES.includes(mode)) {
    mode = "full";
  }

  switch (mode) {
    case "full":
      return { ...snapshot };

    case "truncate":
      return truncateSnapshot(snapshot, TRUNCATE_LIMIT);

    case "compact":
      return truncateSnapshot(filterInternalKeys(snapshot), TRUNCATE_LIMIT);

    case "summary:low":
      return summarySnapshot(snapshot, 0);

    case "summary:medium":
      return summarySnapshot(snapshot, SUMMARY_MEDIUM_LIMIT);

    case "summary:high":
      return summarySnapshot(snapshot, SUMMARY_HIGH_LIMIT);

    default:
      return { ...snapshot };
  }
}

/**
 * Resolve the effective fidelity mode for a node, falling back through
 * the precedence chain defined in spec §5.4:
 *   1. Edge fidelity attribute (on the incoming edge) — HIGHEST
 *   2. Target node fidelity attribute
 *   3. Graph default_fidelity attribute
 *   4. Default: compact
 */
export function resolveEffectiveFidelity(
  edgeFidelity: string,
  nodeFidelity: string,
  graphDefaultFidelity: string,
): FidelityMode {
  if (edgeFidelity && VALID_FIDELITY_MODES.includes(edgeFidelity)) {
    return edgeFidelity as FidelityMode;
  }
  if (nodeFidelity && VALID_FIDELITY_MODES.includes(nodeFidelity)) {
    return nodeFidelity as FidelityMode;
  }
  if (graphDefaultFidelity && VALID_FIDELITY_MODES.includes(graphDefaultFidelity)) {
    return graphDefaultFidelity as FidelityMode;
  }
  return "compact";
}

/**
 * Thread resolution options for resolveThreadKey().
 */
export interface ThreadResolutionOptions {
  /** thread_id attribute on the target node */
  nodeThreadId: string;
  /** thread_id attribute on the incoming edge */
  edgeThreadId: string;
  /** Graph-level default thread (e.g., graph[default_thread]) */
  graphDefaultThread: string;
  /** Derived class from enclosing subgraph (first class entry) */
  subgraphClass: string;
  /** Previous node ID as final fallback */
  previousNodeId: string;
}

/**
 * Resolve the thread key for session reuse when fidelity is "full".
 * Spec §5.4 thread resolution precedence:
 *   1. Target node thread_id attribute
 *   2. Edge thread_id attribute
 *   3. Graph-level default thread
 *   4. Derived class from enclosing subgraph
 *   5. Fallback: previous node ID
 */
export function resolveThreadKey(opts: ThreadResolutionOptions): string {
  if (opts.nodeThreadId) return opts.nodeThreadId;
  if (opts.edgeThreadId) return opts.edgeThreadId;
  if (opts.graphDefaultThread) return opts.graphDefaultThread;
  if (opts.subgraphClass) return opts.subgraphClass;
  return opts.previousNodeId || "default";
}

// ── Internal helpers ──

/** Remove keys that start with "internal." */
function filterInternalKeys(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.startsWith("internal.")) {
      result[key] = value;
    }
  }
  return result;
}

/** Truncate all string values in a snapshot to the given limit */
function truncateSnapshot(
  snapshot: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    result[key] = truncateValue(value, limit);
  }
  return result;
}

/**
 * Build a summary snapshot: keys are always included.
 * If limit === 0 (summary:low), values are replaced with empty strings.
 * Otherwise, values are stringified and truncated to `limit`.
 */
function summarySnapshot(
  snapshot: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (limit === 0) {
      result[key] = "";
    } else {
      result[key] = truncateValue(value, limit);
    }
  }
  return result;
}

/** Truncate a value if it is a string longer than `limit` */
function truncateValue(value: unknown, limit: number): unknown {
  if (typeof value === "string" && value.length > limit) {
    return value.slice(0, limit) + "...";
  }
  return value;
}
