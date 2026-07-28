import { exec } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;

/** Every environment key owned by pi-assert rather than inherited ambiently. */
const MANAGED_ENVIRONMENT_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_SESSION_NAME",
  "PI_SESSION_LEAF_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_MODE",
  "PI_PROJECT_TRUSTED",
  "PI_CONTEXT_TOKENS",
  "PI_CONTEXT_WINDOW",
  "PI_CONTEXT_PERCENT",
  "PI_ASSERT_REF",
  "PI_ASSERT_HOOK",
  "PI_ASSERT_RUN_ID",
  "PI_EVENT",
  "PI_EVENT_PAYLOAD",
  "PI_TOOL_NAME",
  "PI_TOOL_CALL_ID",
  "PI_TOOL_INPUT",
  "PI_TOOL_RESULT",
  "PI_TOOL_IS_ERROR",
  "PI_CWD",
] as const;

export interface ShellResult {
  readonly passed: boolean;
  readonly code: number | null;
}

/** Execute through the real local /bin/sh with bounded runtime. */
export function evaluateShell(
  shell: string,
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const inherited = { ...process.env };
    for (const key of MANAGED_ENVIRONMENT_KEYS) delete inherited[key];

    try {
      const child = exec(shell, {
        env: { ...inherited, ...env, PWD: cwd },
        timeout: DEFAULT_TIMEOUT_MS,
        signal,
        cwd,
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (
          error.name === "AbortError" ||
          signal?.aborted ||
          (error as unknown as { killed?: boolean }).killed
        ) {
          resolve({ passed: false, code: null });
          return;
        }
        resolve({ passed: false, code: null });
      });
      child.on("close", (code: number | null) => {
        resolve({ passed: code === 0, code });
      });
    } catch {
      resolve({ passed: false, code: null });
    }
  });
}
