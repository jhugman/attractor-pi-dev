import type { Graph, GraphNode } from "../model/graph.js";

export interface BackoffConfig {
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoff: BackoffConfig;
  shouldRetry: (error: Error) => boolean;
}

/** Default predicate: retry on transient errors */
function defaultShouldRetry(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  if (msg.includes("5") && msg.includes("server error")) return true;
  if (msg.includes("network") || msg.includes("timeout")) return true;
  if (msg.includes("401") || msg.includes("403")) return false;
  if (msg.includes("400") || msg.includes("bad request")) return false;
  return true; // default to retryable
}

/** Preset retry policies */
export const RETRY_PRESETS: Record<string, RetryPolicy> = {
  none: {
    maxAttempts: 1,
    backoff: { initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0, jitter: false },
    shouldRetry: () => false,
  },
  standard: {
    maxAttempts: 5,
    backoff: { initialDelayMs: 200, backoffFactor: 2.0, maxDelayMs: 60000, jitter: true },
    shouldRetry: defaultShouldRetry,
  },
  aggressive: {
    maxAttempts: 5,
    backoff: { initialDelayMs: 500, backoffFactor: 2.0, maxDelayMs: 60000, jitter: true },
    shouldRetry: defaultShouldRetry,
  },
  linear: {
    maxAttempts: 3,
    backoff: { initialDelayMs: 500, backoffFactor: 1.0, maxDelayMs: 60000, jitter: true },
    shouldRetry: defaultShouldRetry,
  },
  patient: {
    maxAttempts: 3,
    backoff: { initialDelayMs: 2000, backoffFactor: 3.0, maxDelayMs: 60000, jitter: true },
    shouldRetry: defaultShouldRetry,
  },
};

/** Build retry policy from node + graph attributes */
export function buildRetryPolicy(node: GraphNode, graph: Graph): RetryPolicy {
  const maxRetries = node.maxRetries > 0 ? node.maxRetries : 0;
  const maxAttempts = maxRetries + 1;

  return {
    maxAttempts,
    backoff: {
      initialDelayMs: 200,
      backoffFactor: 2.0,
      maxDelayMs: 60000,
      jitter: true,
    },
    shouldRetry: defaultShouldRetry,
  };
}

/** Calculate delay for a retry attempt */
export function delayForAttempt(attempt: number, config: BackoffConfig): number {
  let delay = config.initialDelayMs * Math.pow(config.backoffFactor, attempt - 1);
  delay = Math.min(delay, config.maxDelayMs);
  if (config.jitter) {
    delay = delay * (0.5 + Math.random());
  }
  return Math.round(delay);
}

/** Sleep for given ms */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
