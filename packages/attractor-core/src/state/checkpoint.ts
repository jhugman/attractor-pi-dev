import * as fs from "node:fs";
import * as path from "node:path";

export interface CheckpointData {
  timestamp: string;
  currentNode: string;
  completedNodes: string[];
  nodeRetries: Record<string, number>;
  context: Record<string, unknown>;
  logs: string[];
}

export class Checkpoint {
  timestamp: string;
  currentNode: string;
  completedNodes: string[];
  nodeRetries: Record<string, number>;
  contextValues: Record<string, unknown>;
  logs: string[];

  constructor(opts?: Partial<CheckpointData>) {
    this.timestamp = opts?.timestamp ?? new Date().toISOString();
    this.currentNode = opts?.currentNode ?? "";
    this.completedNodes = opts?.completedNodes ?? [];
    this.nodeRetries = opts?.nodeRetries ?? {};
    this.contextValues = opts?.context ?? {};
    this.logs = opts?.logs ?? [];
  }

  save(logsRoot: string): void {
    const filePath = path.join(logsRoot, "checkpoint.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data: CheckpointData = {
      timestamp: new Date().toISOString(),
      currentNode: this.currentNode,
      completedNodes: this.completedNodes,
      nodeRetries: this.nodeRetries,
      context: this.contextValues,
      logs: this.logs,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  static load(logsRoot: string): Checkpoint {
    const filePath = path.join(logsRoot, "checkpoint.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as CheckpointData;
    return new Checkpoint(data);
  }

  static exists(logsRoot: string): boolean {
    return fs.existsSync(path.join(logsRoot, "checkpoint.json"));
  }
}
