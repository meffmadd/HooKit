import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(import.meta.dirname!, "..");
// Resolve the locked project dependency, never the maintainer's global `pi`.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

type RpcRecord = Record<string, any>;

it("/hooks safely notifies over real RPC at the supported Pi version floor", { timeout: 30_000 }, async (t) => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const piManifest = JSON.parse(readFileSync(join(piDist, "..", "package.json"), "utf8"));
  assert.equal(
    piManifest.version,
    manifest.peerDependencies["@earendil-works/pi-coding-agent"].replace(/^>=/, ""),
    "run this compatibility smoke test with the minimum supported Pi dependency",
  );

  const root = mkdtempSync(join(tmpdir(), "HooKit-rpc-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd);
  const catalogFile = join(agentDir, "hookit.json");
  const catalog = JSON.stringify({
    local: {
      stay: {
        description: "keep this RPC session",
        event: "session_before_switch",
        shell: 'test "$PI_MODE" != rpc',
        default: true,
      },
    },
  });
  writeFileSync(catalogFile, catalog);

  const child = spawn(process.execPath, [
    join(piDist, "cli.js"),
    "--mode", "rpc", "--offline", "--no-session",
    "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-tools", "--no-approve",
    "--extension", join(repoRoot, "hookit", "index.ts"),
  ], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    signal: t.signal,
  });

  const records: RpcRecord[] = [];
  const pending = new Map<string, { resolve: (record: RpcRecord) => void; reject: (error: Error) => void }>();
  let buffer = "";
  let stderr = "";
  let protocolError: Error | undefined;
  let exited = false;
  const fail = (error: Error): void => {
    protocolError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    // Strict JSONL: split on LF only, not Unicode line/paragraph separators.
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      try {
        const record = JSON.parse(line) as RpcRecord;
        assert.ok(record && typeof record === "object" && !Array.isArray(record));
        records.push(record);
        if (record.type === "response" && typeof record.id === "string") {
          pending.get(record.id)?.resolve(record);
          pending.delete(record.id);
        }
      } catch (error) {
        fail(new Error(`Invalid RPC JSONL: ${line}`, { cause: error }));
      }
    }
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  const closed = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      exited = true;
      if (pending.size > 0 || code !== 0) {
        fail(new Error(`Pi exited (${code}): ${stderr}`));
      }
      resolve(code);
    });
  });

  let nextId = 0;
  async function request(type: string, fields: RpcRecord = {}): Promise<RpcRecord> {
    if (protocolError) throw protocolError;
    const id = String(++nextId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await new Promise<RpcRecord>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`RPC ${type} timed out: ${stderr}`)), 10_000);
        child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      });
      assert.equal(response.success, true, JSON.stringify(response));
      return response;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  try {
    const commands = await request("get_commands");
    assert.ok(commands.data.commands.some((command: RpcRecord) => command.name === "hooks"));
    const before = await request("get_entries");
    const commandStart = records.length;

    await request("prompt", { message: "/hooks" });
    const state = await request("get_state"); // no extension_ui_response is ever sent
    const after = await request("get_entries");

    assert.equal(state.data.isStreaming, false);
    assert.deepEqual(after.data, before.data, "no Catalog management or enablement persistence");
    assert.equal(readFileSync(catalogFile, "utf8"), catalog);
    const uiRequests = records.slice(commandStart).filter((record) => record.type === "extension_ui_request");
    assert.equal(uiRequests.length, 1, "one fire-and-forget notification, no dialogs/status refresh");
    assert.equal(typeof uiRequests[0].id, "string");
    assert.equal(uiRequests[0].method, "notify");
    assert.equal(uiRequests[0].notifyType, "error");
    assert.equal(uiRequests[0].message, "hookit: /hooks requires Pi TUI mode.");

    // The management guard must not disable real headless Event Outcome control.
    const switchResult = await request("new_session");
    assert.deepEqual(switchResult.data, { cancelled: true });
    child.stdin.end();
    assert.equal(await closed, 0, stderr);
    assert.equal(protocolError, undefined);
    assert.equal(buffer, "", "stdout ends on a complete JSONL record");
    assert.ok(!records.some((record) => record.type === "extension_error"), JSON.stringify(records));
    assert.ok(!records.some((record) => record.type === "agent_start"), "no model call");
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
