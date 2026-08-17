import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fixture,
  toolResultOutcome,
} from "./fixtures.js";

describe("Core dotenv output safety", () => {
  it("matches qualifying dotenv values literally across supported dotenv syntax", async () => {
    const cwd = fixture("dotenv-output");
    const cases = [
      ["API_KEY=sk-live-1234567890", "prefix sk-live-1234567890 suffix", "patch"],
      ["export SECRET_TOKEN=\"quoted-secret-99\"", "quoted-secret-99", "patch"],
      ["client_secret='single-secret-88'", "single-secret-88", "patch"],
      ["API_KEY=trailing-secret-123   ", "trailing-secret-123", "patch"],
      ["API_KEY=\"quoted-trailing-123\"   ", "quoted-trailing-123", "patch"],
      ["API_KEY = spaced-secret-123", "spaced-secret-123", "patch"],
      ["API_KEY=   leading-secret-123", "leading-secret-123", "patch"],
      ["API_KEY=commented-secret-123 # explanation", "commented-secret-123", "patch"],
      ["API_KEY=\"secret with spaces 123\"", "secret with spaces 123", "patch"],
      ["API_KEY=abc=def12345", "abc=def12345", "patch"],
      ["API_KEY=sk-.*+?()special", "sk-.*+?()special", "patch"],
      ["DATABASE_URL=postgres://secret-looking-value", "postgres://secret-looking-value", "pass"],
      ["DEBUG_KEY=true", "true", "pass"],
      ["KEY=1234567", "1234567", "pass"],
      ["KEY=12345678", "12345678", "patch"],
      ["# API_KEY=commented-secret\nAPI_KEY=real-secret-123", "commented-secret", "pass"],
      ["# API_KEY=commented-secret\nAPI_KEY=real-secret-123", "real-secret-123", "patch"],
      ["API_KEY=first-secret-123\nOTHER_SECRET=second-secret-456", "second-secret-456", "patch"],
    ] as const;

    for (const [dotenv, output, expected] of cases) {
      writeFileSync(join(cwd, ".env"), `${dotenv}\n`);
      assert.equal(
        await toolResultOutcome("no-env-secrets-in-output", "read", output, cwd),
        expected,
        dotenv,
      );
    }

    writeFileSync(join(cwd, ".env"), "API_KEY=bash-secret-123\n");
    assert.equal(
      await toolResultOutcome("no-env-secrets-in-output", "bash", "bash-secret-123", cwd),
      "patch",
    );
  });

  it("skips an absent dotenv file and fails closed when Node is unavailable", async () => {
    const noEnv = fixture("dotenv-absent");
    assert.equal(
      await toolResultOutcome("no-env-secrets-in-output", "read", "unknown-secret", noEnv),
      "pass",
    );

    const cwd = fixture("dotenv-processing");
    writeFileSync(join(cwd, ".env"), "API_KEY=secret-value-123\n");

    const nodeOnly = fixture("dotenv-node-only");
    symlinkSync(process.execPath, join(nodeOnly, "node"));
    assert.equal(
      await toolResultOutcome("no-env-secrets-in-output", "read", "safe", cwd, {
        PATH: nodeOnly,
      }),
      "pass",
    );
    assert.equal(
      await toolResultOutcome("no-env-secrets-in-output", "read", "secret-value-123", cwd, {
        PATH: nodeOnly,
      }),
      "patch",
    );

    assert.equal(
      await toolResultOutcome("no-env-secrets-in-output", "read", "safe", cwd, {
        PATH: fixture("dotenv-no-node"),
      }),
      "patch",
    );
  });
});
