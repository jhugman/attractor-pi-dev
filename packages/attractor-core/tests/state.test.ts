import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Context } from "../src/state/context.js";
import { Checkpoint } from "../src/state/checkpoint.js";
import { ArtifactStore } from "../src/state/artifact-store.js";
import { StageStatus } from "../src/state/types.js";

describe("Context", () => {
  it("set and get values", () => {
    const ctx = new Context();
    ctx.set("key", "value");
    expect(ctx.get("key")).toBe("value");
  });

  it("getString returns default for missing key", () => {
    const ctx = new Context();
    expect(ctx.getString("missing")).toBe("");
    expect(ctx.getString("missing", "default")).toBe("default");
  });

  it("getNumber returns default for missing key", () => {
    const ctx = new Context();
    expect(ctx.getNumber("missing")).toBe(0);
    expect(ctx.getNumber("missing", 42)).toBe(42);
  });

  it("snapshot returns serializable copy", () => {
    const ctx = new Context();
    ctx.set("a", 1);
    ctx.set("b", "hello");
    const snap = ctx.snapshot();
    expect(snap).toEqual({ a: 1, b: "hello" });
  });

  it("clone creates independent copy", () => {
    const ctx = new Context();
    ctx.set("x", 1);
    const cloned = ctx.clone();
    cloned.set("x", 2);
    expect(ctx.get("x")).toBe(1);
    expect(cloned.get("x")).toBe(2);
  });

  it("applyUpdates merges values", () => {
    const ctx = new Context();
    ctx.set("a", 1);
    ctx.applyUpdates({ b: 2, c: 3 });
    expect(ctx.get("a")).toBe(1);
    expect(ctx.get("b")).toBe(2);
    expect(ctx.get("c")).toBe(3);
  });

  it("appendLog and getLogs", () => {
    const ctx = new Context();
    ctx.appendLog("entry1");
    ctx.appendLog("entry2");
    expect(ctx.getLogs()).toEqual(["entry1", "entry2"]);
  });

  it("fromSnapshot restores context", () => {
    const ctx = Context.fromSnapshot({ x: "hello", y: 42 });
    expect(ctx.getString("x")).toBe("hello");
    expect(ctx.getNumber("y")).toBe(42);
  });
});

describe("Checkpoint", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save and load", () => {
    const cp = new Checkpoint({
      currentNode: "plan",
      completedNodes: ["start", "plan"],
      context: { key: "value" },
      nodeRetries: { plan: 1 },
    });
    cp.save(tmpDir);

    expect(Checkpoint.exists(tmpDir)).toBe(true);

    const loaded = Checkpoint.load(tmpDir);
    expect(loaded.currentNode).toBe("plan");
    expect(loaded.completedNodes).toEqual(["start", "plan"]);
    expect(loaded.contextValues).toEqual({ key: "value" });
    expect(loaded.nodeRetries).toEqual({ plan: 1 });
  });
});

describe("ArtifactStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves in-memory artifacts", () => {
    const store = new ArtifactStore();
    store.store("a1", "test artifact", { data: "hello" });
    expect(store.has("a1")).toBe(true);
    expect(store.retrieve("a1")).toEqual({ data: "hello" });
  });

  it("lists artifacts", () => {
    const store = new ArtifactStore();
    store.store("a1", "artifact 1", "data1");
    store.store("a2", "artifact 2", "data2");
    const list = store.list();
    expect(list.length).toBe(2);
  });

  it("removes artifacts", () => {
    const store = new ArtifactStore();
    store.store("a1", "test", "data");
    store.remove("a1");
    expect(store.has("a1")).toBe(false);
  });

  it("clears all artifacts", () => {
    const store = new ArtifactStore();
    store.store("a1", "test1", "data1");
    store.store("a2", "test2", "data2");
    store.clear();
    expect(store.list().length).toBe(0);
  });

  it("throws on retrieve of missing artifact", () => {
    const store = new ArtifactStore();
    expect(() => store.retrieve("nonexistent")).toThrow("Artifact not found");
  });
});
