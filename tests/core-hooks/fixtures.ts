import { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { evaluateCore } from "./index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `HooKit-core-${name}-`));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function executable(path: string, content: string): void {
  writeFileSync(path, `#!/bin/sh\n${content}\n`);
  chmodSync(path, 0o755);
}

export function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
  );
}

export async function assertAgentEndCommand(
  hook: string,
  command: string,
  expectedArguments: string,
  prepare: (cwd: string) => void = () => {},
): Promise<void> {
  const cwd = fixture(hook);
  const bin = join(cwd, "bin");
  const log = join(cwd, `${command}.log`);
  mkdirSync(bin);
  executable(
    join(bin, command),
    "printf '%s\\n' \"$*\" > \"$HOOKIT_COMMAND_LOG\"; exit \"${HOOKIT_COMMAND_EXIT:-0}\"",
  );
  prepare(cwd);
  const environment = { PATH: bin, HOOKIT_COMMAND_LOG: log };

  assert.equal(await agentEndOutcome(hook, cwd, environment), "pass");
  assert.equal(readFileSync(log, "utf8").trim(), expectedArguments);
  assert.equal(
    await agentEndOutcome(hook, cwd, {
      ...environment,
      HOOKIT_COMMAND_EXIT: "7",
    }),
    "report",
  );
}

export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n") +
    (count === 0 ? "" : "\n");
}

export function gitRepository(name: string, lineCount = 20): string {
  const cwd = fixture(name);
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "hookit@example.test");
  git(cwd, "config", "user.name", "HooKit Test");
  writeFileSync(join(cwd, "base.txt"), lines(lineCount, "base"));
  git(cwd, "add", "base.txt");
  git(cwd, "commit", "--quiet", "-m", "baseline");
  return cwd;
}

export async function toolCallOutcome(
  hook: string,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  metadata: Record<string, string> = {},
): Promise<string> {
  const evaluated = await evaluateCore(
    hook,
    "tool_call",
    { toolName, toolCallId: "call-1", input },
    cwd,
    metadata,
  );
  return evaluated.eventOutcomes[0].outcome;
}

export async function toolResultOutcome(
  hook: string,
  toolName: string,
  text: string,
  cwd: string,
  metadata: Record<string, string> = {},
): Promise<string> {
  const evaluated = await evaluateCore(
    hook,
    "tool_result",
    {
      toolName,
      toolCallId: "call-1",
      input: { path: "file.txt" },
      content: [{ type: "text", text }],
      isError: false,
    },
    cwd,
    metadata,
  );
  return evaluated.eventOutcomes[0].outcome;
}

export async function agentEndOutcome(
  hook: string,
  cwd: string,
  metadata: Record<string, string> = {},
): Promise<string> {
  const evaluated = await evaluateCore(hook, "agent_end", {}, cwd, metadata);
  return evaluated.eventOutcomes[0].outcome;
}
