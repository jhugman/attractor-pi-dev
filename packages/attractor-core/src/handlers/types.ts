import type { Graph, GraphNode } from "../model/graph.js";
import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";

/** Common interface for all node handlers */
export interface Handler {
  execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome>;
}

/** Backend interface for LLM/code generation tasks */
export interface CodergenBackend {
  run(node: GraphNode, prompt: string, context: Context): Promise<string | Outcome>;
}

/** Human interaction question model */
export enum QuestionType {
  YES_NO = "yes_no",
  MULTIPLE_CHOICE = "multiple_choice",
  FREEFORM = "freeform",
  CONFIRMATION = "confirmation",
}

export interface QuestionOption {
  key: string;
  label: string;
}

export interface Question {
  text: string;
  type: QuestionType;
  options: QuestionOption[];
  default?: Answer;
  timeoutSeconds?: number;
  stage: string;
  metadata?: Record<string, unknown>;
}

export enum AnswerValue {
  YES = "yes",
  NO = "no",
  SKIPPED = "skipped",
  TIMEOUT = "timeout",
}

export interface Answer {
  value: string | AnswerValue;
  selectedOption?: QuestionOption;
  text?: string;
}

/** Interface for all human interaction */
export interface Interviewer {
  ask(question: Question): Promise<Answer>;
  askMultiple?(questions: Question[]): Promise<Answer[]>;
  inform?(message: string, stage: string): Promise<void>;
}
