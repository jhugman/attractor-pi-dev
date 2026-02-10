import * as fs from "node:fs";
import * as path from "node:path";

const FILE_BACKING_THRESHOLD = 100 * 1024; // 100KB

export interface ArtifactInfo {
  id: string;
  name: string;
  sizeBytes: number;
  storedAt: string;
  isFileBacked: boolean;
}

export class ArtifactStore {
  private artifacts = new Map<string, { info: ArtifactInfo; data: unknown }>();
  private baseDir: string | null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? null;
  }

  store(artifactId: string, name: string, data: unknown): ArtifactInfo {
    const serialized = JSON.stringify(data);
    const sizeBytes = Buffer.byteLength(serialized, "utf-8");
    const isFileBacked = sizeBytes > FILE_BACKING_THRESHOLD && this.baseDir !== null;

    if (isFileBacked) {
      const dir = path.join(this.baseDir!, "artifacts");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${artifactId}.json`);
      fs.writeFileSync(filePath, serialized);
    }

    const info: ArtifactInfo = {
      id: artifactId,
      name,
      sizeBytes,
      storedAt: new Date().toISOString(),
      isFileBacked,
    };

    this.artifacts.set(artifactId, {
      info,
      data: isFileBacked ? path.join(this.baseDir!, "artifacts", `${artifactId}.json`) : data,
    });

    return info;
  }

  retrieve(artifactId: string): unknown {
    const entry = this.artifacts.get(artifactId);
    if (!entry) throw new Error(`Artifact not found: ${artifactId}`);
    if (entry.info.isFileBacked) {
      return JSON.parse(fs.readFileSync(entry.data as string, "utf-8"));
    }
    return entry.data;
  }

  has(artifactId: string): boolean {
    return this.artifacts.has(artifactId);
  }

  list(): ArtifactInfo[] {
    return [...this.artifacts.values()].map((e) => e.info);
  }

  remove(artifactId: string): void {
    const entry = this.artifacts.get(artifactId);
    if (entry?.info.isFileBacked) {
      try {
        fs.unlinkSync(entry.data as string);
      } catch {
        // ignore
      }
    }
    this.artifacts.delete(artifactId);
  }

  clear(): void {
    for (const [id] of this.artifacts) {
      this.remove(id);
    }
  }
}
