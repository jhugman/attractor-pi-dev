/** Pipeline event types */
export type PipelineEvent =
  | PipelineStartedEvent
  | PipelineCompletedEvent
  | PipelineFailedEvent
  | StageStartedEvent
  | StageCompletedEvent
  | StageFailedEvent
  | StageRetryingEvent
  | ParallelStartedEvent
  | ParallelBranchStartedEvent
  | ParallelBranchCompletedEvent
  | ParallelCompletedEvent
  | InterviewStartedEvent
  | InterviewCompletedEvent
  | InterviewTimeoutEvent
  | CheckpointSavedEvent
  | CheckpointResumedEvent
  | LoopRestartedEvent;

export interface PipelineStartedEvent {
  type: "pipeline_started";
  name: string;
  id: string;
  timestamp: string;
}

export interface PipelineCompletedEvent {
  type: "pipeline_completed";
  durationMs: number;
  artifactCount: number;
  timestamp: string;
}

export interface PipelineFailedEvent {
  type: "pipeline_failed";
  error: string;
  durationMs: number;
  timestamp: string;
}

export interface StageStartedEvent {
  type: "stage_started";
  name: string;
  index: number;
  timestamp: string;
}

export interface StageCompletedEvent {
  type: "stage_completed";
  name: string;
  index: number;
  durationMs: number;
  timestamp: string;
}

export interface StageFailedEvent {
  type: "stage_failed";
  name: string;
  index: number;
  error: string;
  willRetry: boolean;
  timestamp: string;
}

export interface StageRetryingEvent {
  type: "stage_retrying";
  name: string;
  index: number;
  attempt: number;
  delayMs: number;
  timestamp: string;
}

export interface ParallelStartedEvent {
  type: "parallel_started";
  branchCount: number;
  timestamp: string;
}

export interface ParallelBranchStartedEvent {
  type: "parallel_branch_started";
  branch: string;
  index: number;
  timestamp: string;
}

export interface ParallelBranchCompletedEvent {
  type: "parallel_branch_completed";
  branch: string;
  index: number;
  durationMs: number;
  success: boolean;
  timestamp: string;
}

export interface ParallelCompletedEvent {
  type: "parallel_completed";
  durationMs: number;
  successCount: number;
  failureCount: number;
  timestamp: string;
}

export interface InterviewStartedEvent {
  type: "interview_started";
  question: string;
  stage: string;
  timestamp: string;
}

export interface InterviewCompletedEvent {
  type: "interview_completed";
  question: string;
  answer: string;
  durationMs: number;
  timestamp: string;
}

export interface InterviewTimeoutEvent {
  type: "interview_timeout";
  question: string;
  stage: string;
  durationMs: number;
  timestamp: string;
}

export interface CheckpointSavedEvent {
  type: "checkpoint_saved";
  nodeId: string;
  timestamp: string;
}

export interface CheckpointResumedEvent {
  type: "checkpoint_resumed";
  resumedFromNode: string;
  skippedNodes: string[];
  timestamp: string;
}

export interface LoopRestartedEvent {
  type: "loop_restarted";
  fromNode: string;
  toNode: string;
  timestamp: string;
}

/** Event listener type */
export type EventListener = (event: PipelineEvent) => void;

/** Simple event emitter for pipeline events */
export class EventEmitter {
  private listeners: EventListener[] = [];
  private eventLog: PipelineEvent[] = [];

  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: PipelineEvent): void {
    this.eventLog.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getEvents(): readonly PipelineEvent[] {
    return this.eventLog;
  }

  /** Create an async iterator for events */
  async *stream(): AsyncGenerator<PipelineEvent> {
    let resolve: ((event: PipelineEvent) => void) | null = null;
    const queue: PipelineEvent[] = [];

    const unsub = this.on((event) => {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(event);
      } else {
        queue.push(event);
      }
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          yield await new Promise<PipelineEvent>((r) => {
            resolve = r;
          });
        }
      }
    } finally {
      unsub();
    }
  }
}
