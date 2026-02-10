import type { GraphNode } from "../model/graph.js";
import { SHAPE_TO_HANDLER_TYPE } from "../model/types.js";
import type { Handler, Interviewer, CodergenBackend } from "./types.js";
import {
  StartHandler,
  ExitHandler,
  ConditionalHandler,
  CodergenHandler,
  WaitForHumanHandler,
  ParallelHandler,
  FanInHandler,
  ToolHandler,
  ManagerLoopHandler,
} from "./handlers.js";
import { AutoApproveInterviewer } from "./interviewers.js";

/** Registry mapping handler type strings to handler instances */
export class HandlerRegistry {
  private handlers = new Map<string, Handler>();
  private defaultHandler: Handler;

  constructor(opts?: {
    backend?: CodergenBackend | null;
    interviewer?: Interviewer;
  }) {
    const backend = opts?.backend ?? null;
    const interviewer = opts?.interviewer ?? new AutoApproveInterviewer();

    this.defaultHandler = new CodergenHandler(backend);

    // Register built-in handlers
    this.register("start", new StartHandler());
    this.register("exit", new ExitHandler());
    this.register("conditional", new ConditionalHandler());
    this.register("codergen", new CodergenHandler(backend));
    this.register("wait.human", new WaitForHumanHandler(interviewer));
    this.register("parallel", new ParallelHandler());
    this.register("parallel.fan_in", new FanInHandler());
    this.register("tool", new ToolHandler());
    this.register("stack.manager_loop", new ManagerLoopHandler());
  }

  register(typeString: string, handler: Handler): void {
    this.handlers.set(typeString, handler);
  }

  resolve(node: GraphNode): Handler {
    // 1. Explicit type attribute
    if (node.type && this.handlers.has(node.type)) {
      return this.handlers.get(node.type)!;
    }

    // 2. Shape-based resolution
    const handlerType = SHAPE_TO_HANDLER_TYPE[node.shape];
    if (handlerType && this.handlers.has(handlerType)) {
      return this.handlers.get(handlerType)!;
    }

    // 3. Default
    return this.defaultHandler;
  }

  /** Get the parallel handler for wiring the subgraph executor */
  getParallelHandler(): ParallelHandler | undefined {
    const handler = this.handlers.get("parallel");
    if (handler instanceof ParallelHandler) return handler;
    return undefined;
  }
}
