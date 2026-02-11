/**
 * Patterns for sensitive environment variable names (case-insensitive).
 * Variables matching these suffixes are excluded from the shell environment.
 */
const SENSITIVE_SUFFIXES = [
  "_API_KEY",
  "_SECRET",
  "_TOKEN",
  "_PASSWORD",
  "_CREDENTIAL",
];

/**
 * Exact variable names that are always sensitive.
 */
const SENSITIVE_EXACT = new Set([
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "CREDENTIAL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/**
 * Variables that are always included, regardless of name patterns.
 */
const ALWAYS_INCLUDE = new Set([
  // System essentials
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // Language-specific paths
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "NODE_PATH",
  "NPM_CONFIG_PREFIX",
  // Build/runtime
  "CC",
  "CXX",
  "CFLAGS",
  "LDFLAGS",
  "PKG_CONFIG_PATH",
  "PYTHONPATH",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_PATH",
]);

/**
 * Check if an environment variable name matches a sensitive pattern.
 */
function isSensitive(name: string): boolean {
  const upper = name.toUpperCase();
  if (SENSITIVE_EXACT.has(upper)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

export type EnvFilterPolicy = "inherit_all" | "inherit_core" | "inherit_none";

/**
 * Filter environment variables based on policy.
 *
 * @param env - The source environment (defaults to process.env)
 * @param policy - Filter policy:
 *   - "inherit_all": Include everything except sensitive vars
 *   - "inherit_core": Only include ALWAYS_INCLUDE vars (default)
 *   - "inherit_none": Empty environment (only PATH is included for basic functionality)
 * @param extraInclude - Additional variable names to always include
 * @param extraExclude - Additional variable names to always exclude
 */
export function filterEnv(
  env: NodeJS.ProcessEnv = process.env,
  policy: EnvFilterPolicy = "inherit_all",
  extraInclude?: Set<string>,
  extraExclude?: Set<string>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  if (policy === "inherit_none") {
    // Only PATH for basic functionality
    if (env["PATH"]) result["PATH"] = env["PATH"];
    return result;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    // Extra excludes always win
    if (extraExclude?.has(key)) continue;

    // Extra includes always win
    if (extraInclude?.has(key)) {
      result[key] = value;
      continue;
    }

    // Always-include set bypasses sensitive check
    if (ALWAYS_INCLUDE.has(key)) {
      result[key] = value;
      continue;
    }

    if (policy === "inherit_core") {
      // Only ALWAYS_INCLUDE vars (already handled above)
      continue;
    }

    // policy === "inherit_all": include unless sensitive
    if (!isSensitive(key)) {
      result[key] = value;
    }
  }

  return result;
}
