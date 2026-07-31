/**
 * Tests that schema.json is a valid JSON Schema and that example
 * asserts.json files (both project .pi/asserts.json and the SKILL.md
 * examples) validate correctly.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { validateRuleEntry } from "../pi-assert/domain/validation.js";

// ── Load the schema ────────────────────────────────────────────────

const schemaPath = join(import.meta.dirname!, "..", "schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

// ═══════════════════════════════════════════════════════════════════
// Schema validity
// ═══════════════════════════════════════════════════════════════════

describe("schema self-validation", () => {
  it("schema.json is valid JSON Schema (draft-07)", () => {
    assert.ok(validate);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Runtime/schema parity for Action Handlers
// ═══════════════════════════════════════════════════════════════════

describe("Action Handler runtime/schema parity", () => {
  const actionCases: Array<{ action: unknown; expected: boolean }> = [
    { action: { type: "interrupt" }, expected: true },
    { action: { type: "shutdown" }, expected: true },
    { action: { type: "shutdown", interrupt: true }, expected: true },
    { action: { type: "compact" }, expected: true },
    { action: { type: "compact", instructions: "Keep decisions" }, expected: true },
    {
      action: { type: "message", message: "Now", delivery: "steer" },
      expected: true,
    },
    {
      action: {
        type: "message",
        message: "Later",
        delivery: "followUp",
        triggerTurn: true,
      },
      expected: true,
    },
    {
      action: { type: "message", message: "Next", delivery: "nextTurn" },
      expected: true,
    },
    {
      action: {
        type: "emit-custom-event",
        name: "example:event",
        data: { nested: [true, 1, null] },
      },
      expected: true,
    },
    {
      action: {
        type: "message",
        message: "Invalid",
        delivery: "nextTurn",
        triggerTurn: true,
      },
      expected: false,
    },
    { action: { type: "interrupt", extra: true }, expected: false },
    { action: { type: "emit-custom-event", name: "   " }, expected: false },
  ];

  for (const [index, { action, expected }] of actionCases.entries()) {
    it(`keeps action variant ${index} aligned`, () => {
      const entry = {
        description: "d",
        hook: "tool_call",
        action,
      };
      const schemaAccepts = validate({ local: { rule: entry } });
      const runtimeAccepts = validateRuleEntry(entry)?.kind === "action";
      assert.equal(schemaAccepts, expected, JSON.stringify(validate.errors));
      assert.equal(runtimeAccepts, expected);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// validate(config) → boolean
// ═══════════════════════════════════════════════════════════════════

describe("validate", () => {
  type Case = { label: string; config: unknown; expected: boolean };

  const cases: Case[] = [
    // ── SKILL.md examples ──────────────────────────────────────────

    {
      label: "block all write tool calls",
      config: {
        local: {
          unmodified: {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "guard specific file paths",
      config: {
        local: {
          "protect-env-files": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -q \'\\.env\' && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "no secrets in env",
      config: {
        local: {
          "no-secrets-in-env": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -q SECRET_KEY <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "block rm -rf",
      config: {
        local: {
          "block-rm-rf": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -qE \'rm[[:space:]]+-rf\' <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "write only in src",
      config: {
        local: {
          "write-only-in-src": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -q \'"path":"src/\' && exit 0 || exit 1',
          },
        },
      },
      expected: true,
    },

    {
      label: "no sensitive reads",
      config: {
        local: {
          "no-sensitive-reads": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "read" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -qE \'\\.(env|pem|key)\' && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "default-based activation example",
      config: {
        local: {
          "always-active": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
            default: true,
          },
          "opt-in": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: "false",
            default: false,
          },
        },
      },
      expected: true,
    },

    // ── Invalid configs ────────────────────────────────────────────

    {
      label: "missing required 'description'",
      config: { local: { bad: { hook: "tool_call", shell: "true" } } },
      expected: false,
    },

    {
      label: "missing required 'hook'",
      config: { local: { bad: { description: "d", shell: "true" } } },
      expected: false,
    },

    {
      label: "missing required 'shell'",
      config: { local: { bad: { description: "d", hook: "tool_call" } } },
      expected: false,
    },

    {
      label: "unknown property at assert level",
      config: {
        local: {
          bad: {
            description: "d",
            hook: "tool_call",
            shell: "true",
            extraProp: "should not be here",
          },
        },
      },
      expected: false,
    },

    {
      label: "hook value not in enum",
      config: { local: { bad: { description: "d", hook: "invalid_hook", shell: "true" } } },
      expected: false,
    },

    {
      label: "default is not boolean",
      config: {
        local: { bad: { description: "d", hook: "tool_call", shell: "true", default: "yes" } },
      },
      expected: false,
    },

    {
      label: "top-level array rejected",
      config: [],
      expected: false,
    },

    {
      label: "top-level string rejected",
      config: "string",
      expected: false,
    },

    {
      label: "top-level null rejected",
      config: null,
      expected: false,
    },

    // ── Section-based validation ───────────────────────────────────

    {
      label: "accepts local section with valid asserts",
      config: { local: { guard: { description: "d", hook: "tool_call", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts repo section with valid asserts",
      config: {
        "meffmadd/pi-assert-rules": {
          "block-write": { description: "d", hook: "tool_call", shell: "false" },
        },
      },
      expected: true,
    },

    {
      label: "accepts mixed local and repo sections",
      config: {
        local: { custom: { description: "d", hook: "tool_call", shell: "true" } },
        "some/repo": { installed: { description: "d", hook: "tool_call", shell: "false" } },
      },
      expected: true,
    },

    {
      label: "accepts $schema alongside sections",
      config: {
        $schema: "https://example.com/schema.json",
        local: { guard: { description: "d", hook: "tool_call", shell: "true" } },
      },
      expected: true,
    },

    {
      label: "accepts repos array with valid entries",
      config: {
        repos: ["meffmadd/pi-assert-rules"],
        local: { guard: { description: "d", hook: "tool_call", shell: "true" } },
        "meffmadd/pi-assert-rules": {
          block: { description: "d", hook: "tool_call", shell: "false" },
        },
      },
      expected: true,
    },

    {
      label: "repos must be an array",
      config: { repos: "not-an-array" },
      expected: false,
    },

    {
      label: "repos entries must be owner/repo format",
      config: { repos: ["no-slash"] },
      expected: false,
    },

    {
      label: "repos entries must be unique",
      config: { repos: ["a/b", "a/b"] },
      expected: false,
    },

    // ── Schema evolution ───────────────────────────────────────────

    {
      label: "accepts 'tool_call' as hook",
      config: { local: { guard: { description: "d", hook: "tool_call", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'tool_result' as hook",
      config: { local: { guard: { description: "d", hook: "tool_result", shell: "true" } } },
      expected: true,
    },

    {
      label: "tool_result with filter and when",
      config: {
        local: {
          "block-secrets-in-reads": {
            description: "d",
            hook: "tool_result",
            filter: { toolName: "read" },
            shell: "grep -qE 'SECRET' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
            when: "true",
            default: false,
          },
        },
      },
      expected: true,
    },

    {
      label: "accepts 'turn_end' as hook",
      config: { local: { guard: { description: "d", hook: "turn_end", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'agent_settled' as hook",
      config: { local: { guard: { description: "d", hook: "agent_settled", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'session_before_switch' as hook",
      config: { local: { guard: { description: "d", hook: "session_before_switch", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'session_before_fork' as hook",
      config: { local: { guard: { description: "d", hook: "session_before_fork", shell: "true" } } },
      expected: true,
    },

    {
      label: "rejects 'session_shutdown' because it has no cancellation contract",
      config: { local: { guard: { description: "d", hook: "session_shutdown", shell: "true" } } },
      expected: false,
    },

    {
      label: "accepts assert_result with its bounded filter",
      config: {
        local: {
          handler: {
            description: "d",
            hook: "assert_result",
            filter: {
              event: "^assert_result$",
              assertionRef: "^local/",
              runId: "^[0-9a-f-]+$",
              outcome: ["pass", "block", "patch", "cancel", "report"],
              code: [0, 1, null],
            },
            shell: "true",
          },
        },
      },
      expected: true,
    },
    {
      label: "rejects unknown assert_result outcome",
      config: {
        local: {
          handler: {
            description: "d",
            hook: "assert_result",
            filter: { outcome: "error" },
            shell: "true",
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects regex syntax in exact assert_result outcome",
      config: {
        local: {
          handler: {
            description: "d",
            hook: "assert_result",
            filter: { outcome: "p.*" },
            shell: "true",
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects string assert_result code filters",
      config: {
        local: {
          handler: {
            description: "d",
            hook: "assert_result",
            filter: { code: "^1$" },
            shell: "true",
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects unbounded assert_result filter fields",
      config: {
        local: {
          handler: {
            description: "d",
            hook: "assert_result",
            filter: { originHook: "tool_call" },
            shell: "true",
          },
        },
      },
      expected: false,
    },

    {
      label: "accepts 'agent_end' as hook",
      config: { local: { guard: { description: "d", hook: "agent_end", shell: "true" } } },
      expected: true,
    },

    {
      label: "agent_end with when and default",
      config: {
        local: {
          "check-git-clean": {
            description: "d",
            hook: "agent_end",
            shell: "git diff --quiet",
            when: "test -d .git",
            default: true,
          },
        },
      },
      expected: true,
    },

    // ── Structured regex filters ────────────────────────────────────

    {
      label: "accepts regex strings on dot-separated nested keys",
      config: {
        local: {
          "protect-env": {
            description: "d",
            hook: "tool_call",
            filter: {
              toolName: "_write$",
              "request.target.path": "(^|/)\\.env.*$",
            },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "accepts mixed regex and strict scalar array members",
      config: {
        local: {
          mixed: {
            description: "d",
            hook: "tool_call",
            filter: { value: ["^ten$", 10, false, null] },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    // ── Array filter values (any-of) ─────────────────────────────────

    {
      label: "accepts array filter value for toolName (any-of)",
      config: {
        local: {
          "block-writes": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: ["write", "edit"] },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "accepts single-element array filter value",
      config: {
        local: {
          "block-write": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: ["write"] },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "accepts empty array filter value",
      config: {
        local: {
          "noop": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: [] },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "accepts array filter on a non-toolName key",
      config: {
        local: {
          "block-commands": {
            description: "d",
            hook: "tool_call",
            filter: { command: ["ls", "pwd"] },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "rejects object element inside a filter array",
      config: {
        local: {
          "bad": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: [{ write: true }] },
            shell: "false",
          },
        },
      },
      expected: false,
    },

    // ── Action Handler entries ──────────────────────────────────────

    ...[
      { type: "interrupt" },
      { type: "shutdown" },
      { type: "shutdown", interrupt: true },
      { type: "compact" },
      { type: "compact", instructions: "Keep decisions" },
      { type: "message", message: "Review this", delivery: "steer" },
      {
        type: "message",
        message: "Continue later",
        delivery: "followUp",
        triggerTurn: true,
      },
      { type: "message", message: "For next prompt", delivery: "nextTurn" },
      { type: "emit-custom-event", name: "example:ready" },
      {
        type: "emit-custom-event",
        name: "example:data",
        data: { nested: [true, 2, null] },
      },
    ].map((action, index) => ({
      label: `accepts Action Handler variant ${index}`,
      config: {
        local: {
          action: {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "^bash$" },
            when: "true",
            action,
            default: true,
          },
        },
      },
      expected: true,
    })),
    {
      label: "rejects nextTurn with triggerTurn true",
      config: {
        local: {
          action: {
            description: "d",
            hook: "tool_call",
            action: {
              type: "message",
              message: "bad",
              delivery: "nextTurn",
              triggerTurn: true,
            },
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects an unknown action field",
      config: {
        local: {
          action: {
            description: "d",
            hook: "tool_call",
            action: { type: "interrupt", extra: true },
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects an empty custom event name",
      config: {
        local: {
          action: {
            description: "d",
            hook: "tool_call",
            action: { type: "emit-custom-event", name: "   " },
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects an entry carrying both shell and action",
      config: {
        local: {
          ambiguous: {
            description: "d",
            hook: "tool_call",
            shell: "true",
            action: { type: "interrupt" },
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects an inert entry without shell, action, or preset",
      config: {
        local: { inert: { description: "d", hook: "tool_call" } },
      },
      expected: false,
    },
    {
      label: "accepts an assert_result Action Handler",
      config: {
        local: {
          action: {
            description: "d",
            hook: "assert_result",
            filter: { outcome: ["block", "patch"], code: [1, null] },
            action: { type: "interrupt" },
          },
        },
      },
      expected: true,
    },

    // ── Preset entries (oneOf executable | preset) ──────────────────

    {
      label: "accepts a preset with description + preset refs",
      config: {
        local: {
          "my-preset": {
            description: "Block destructive writes",
            preset: ["local/block-rm-rf", "meffmadd/pi-assert-rules/protect-env"],
          },
        },
      },
      expected: true,
    },
    {
      label: "accepts a preset with an empty preset array",
      config: {
        local: { "my-preset": { description: "d", preset: [] } },
      },
      expected: true,
    },
    {
      label: "accepts a preset with default: true",
      config: {
        local: { "my-preset": { description: "d", preset: ["local/a"], default: true } },
      },
      expected: true,
    },
    {
      label: "rejects a preset missing description",
      config: { local: { p: { preset: ["local/a"] } } },
      expected: false,
    },
    {
      label: "rejects a preset missing the preset array",
      config: { local: { p: { description: "d" } } },
      expected: false,
    },
    {
      label: "rejects a preset carrying shell (mutual exclusivity)",
      config: {
        local: { p: { description: "d", preset: [], shell: "false" } },
      },
      expected: false,
    },
    {
      label: "rejects a preset carrying hook (mutual exclusivity)",
      config: {
        local: { p: { description: "d", preset: [], hook: "tool_call" } },
      },
      expected: false,
    },
    {
      label: "rejects a preset carrying when (assert-only)",
      config: {
        local: { p: { description: "d", preset: [], when: "true" } },
      },
      expected: false,
    },
    {
      label: "rejects a preset carrying filter (assert-only)",
      config: {
        local: { p: { description: "d", preset: [], filter: { toolName: "bash" } } },
      },
      expected: false,
    },
    {
      label: "rejects a preset with a non-array preset field",
      config: {
        local: { p: { description: "d", preset: "local/a" } },
      },
      expected: false,
    },
    {
      label: "rejects a preset with a non-string ref",
      config: {
        local: { p: { description: "d", preset: [123] } },
      },
      expected: false,
    },
    {
      label: "rejects a preset with an unknown property (additionalProperties: false)",
      config: {
        local: { p: { description: "d", preset: [], extraProp: "x" } },
      },
      expected: false,
    },
    {
      label: "rejects an entry carrying both shell and preset (oneOf mutual exclusivity)",
      config: {
        local: {
          p: { description: "d", hook: "tool_call", shell: "false", preset: ["local/a"] },
        },
      },
      expected: false,
    },
    {
      label: "accepts a preset in a repo section",
      config: {
        "some/repo": { p: { description: "d", preset: ["local/a"] } },
      },
      expected: true,
    },
  ];

  for (const { label, config, expected } of cases) {
    it(label, () => {
      assert.strictEqual(validate(config), expected);
    });
  }
});
