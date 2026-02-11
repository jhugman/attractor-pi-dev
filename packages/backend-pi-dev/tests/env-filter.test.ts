import { describe, it, expect } from "vitest";
import { filterEnv } from "../src/env-filter.js";

describe("filterEnv", () => {
  const testEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    USER: "testuser",
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "sk-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    MY_APP_TOKEN: "token-value",
    DATABASE_PASSWORD: "dbpass",
    GITHUB_CREDENTIAL: "cred-value",
    CUSTOM_VAR: "custom-value",
    NODE_ENV: "development",
    GOPATH: "/home/user/go",
  };

  describe("inherit_all policy", () => {
    it("includes non-sensitive variables", () => {
      const result = filterEnv(testEnv, "inherit_all");
      expect(result["PATH"]).toBe("/usr/bin");
      expect(result["HOME"]).toBe("/home/user");
      expect(result["CUSTOM_VAR"]).toBe("custom-value");
      expect(result["NODE_ENV"]).toBe("development");
    });

    it("excludes variables matching sensitive patterns", () => {
      const result = filterEnv(testEnv, "inherit_all");
      expect(result["OPENAI_API_KEY"]).toBeUndefined();
      expect(result["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(result["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
      expect(result["MY_APP_TOKEN"]).toBeUndefined();
      expect(result["DATABASE_PASSWORD"]).toBeUndefined();
      expect(result["GITHUB_CREDENTIAL"]).toBeUndefined();
    });

    it("always includes safe system vars even if they look sensitive", () => {
      const result = filterEnv(testEnv, "inherit_all");
      expect(result["GOPATH"]).toBe("/home/user/go");
    });
  });

  describe("inherit_core policy", () => {
    it("only includes ALWAYS_INCLUDE vars", () => {
      const result = filterEnv(testEnv, "inherit_core");
      expect(result["PATH"]).toBe("/usr/bin");
      expect(result["HOME"]).toBe("/home/user");
      expect(result["SHELL"]).toBe("/bin/bash");
      expect(result["GOPATH"]).toBe("/home/user/go");
    });

    it("excludes non-core variables", () => {
      const result = filterEnv(testEnv, "inherit_core");
      expect(result["CUSTOM_VAR"]).toBeUndefined();
      expect(result["NODE_ENV"]).toBeUndefined();
    });

    it("excludes sensitive variables", () => {
      const result = filterEnv(testEnv, "inherit_core");
      expect(result["OPENAI_API_KEY"]).toBeUndefined();
    });
  });

  describe("inherit_none policy", () => {
    it("only includes PATH", () => {
      const result = filterEnv(testEnv, "inherit_none");
      expect(result["PATH"]).toBe("/usr/bin");
      expect(Object.keys(result)).toHaveLength(1);
    });
  });

  describe("extraInclude and extraExclude", () => {
    it("extraInclude overrides sensitive exclusion", () => {
      const result = filterEnv(
        testEnv,
        "inherit_all",
        new Set(["OPENAI_API_KEY"]),
      );
      expect(result["OPENAI_API_KEY"]).toBe("sk-secret");
    });

    it("extraExclude overrides everything", () => {
      const result = filterEnv(
        testEnv,
        "inherit_all",
        undefined,
        new Set(["PATH"]),
      );
      expect(result["PATH"]).toBeUndefined();
    });
  });

  describe("case-insensitive pattern matching", () => {
    it("matches _api_key suffix case-insensitively", () => {
      const env = { my_api_key: "value" };
      const result = filterEnv(env, "inherit_all");
      expect(result["my_api_key"]).toBeUndefined();
    });
  });
});
