/** Handler type derived from shape */
export type HandlerType =
  | "start"
  | "exit"
  | "codergen"
  | "wait.human"
  | "conditional"
  | "parallel"
  | "parallel.fan_in"
  | "tool"
  | "stack.manager_loop"
  | string;

/** Shape-to-handler-type mapping */
export const SHAPE_TO_HANDLER_TYPE: Record<string, HandlerType> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  hexagon: "wait.human",
  diamond: "conditional",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
  house: "stack.manager_loop",
};

/** Fidelity mode for context management */
export type FidelityMode =
  | "full"
  | "truncate"
  | "compact"
  | "summary:low"
  | "summary:medium"
  | "summary:high";

export const VALID_FIDELITY_MODES: string[] = [
  "full",
  "truncate",
  "compact",
  "summary:low",
  "summary:medium",
  "summary:high",
];

/** Duration value in milliseconds */
export function parseDuration(value: string): number {
  const match = value.match(/^(-?\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const num = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case "ms":
      return num;
    case "s":
      return num * 1000;
    case "m":
      return num * 60_000;
    case "h":
      return num * 3_600_000;
    case "d":
      return num * 86_400_000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}
