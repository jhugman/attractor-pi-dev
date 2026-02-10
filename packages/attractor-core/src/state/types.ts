/** Outcome status for node execution */
export enum StageStatus {
  SUCCESS = "success",
  PARTIAL_SUCCESS = "partial_success",
  RETRY = "retry",
  FAIL = "fail",
  SKIPPED = "skipped",
}

/** Result of executing a node handler */
export interface Outcome {
  status: StageStatus;
  preferredLabel?: string;
  suggestedNextIds?: string[];
  contextUpdates?: Record<string, unknown>;
  notes?: string;
  failureReason?: string;
}

/** Create an Outcome with defaults */
export function outcome(
  status: StageStatus,
  opts?: Partial<Omit<Outcome, "status">>,
): Outcome {
  return { status, ...opts };
}

export function successOutcome(
  opts?: Partial<Omit<Outcome, "status">>,
): Outcome {
  return outcome(StageStatus.SUCCESS, opts);
}

export function failOutcome(
  reason: string,
  opts?: Partial<Omit<Outcome, "status" | "failureReason">>,
): Outcome {
  return outcome(StageStatus.FAIL, { failureReason: reason, ...opts });
}
