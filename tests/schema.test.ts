/**
 * Tests that schema.json is a valid JSON Schema and that example
 * hookit.json files (both project .pi/hookit.json and the SKILL.md
 * examples) validate correctly.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import {
  isValidEntryName,
  validateHookEntry,
} from "../hookit/domain/validation.js";

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
// Runtime/schema parity for owned Actions
// ═══════════════════════════════════════════════════════════════════

describe("owned Action runtime/schema parity", () => {
  const actionCases: Array<{ action: unknown; expected: boolean }> = [
    { action: { type: "interrupt", outcome: "pass" }, expected: true },
    { action: { type: "shutdown", outcome: ["pass", "block"], code: [0, 1] }, expected: true },
    { action: { type: "shutdown", outcome: "block", code: null, interrupt: true }, expected: true },
    { action: { type: "compact", outcome: "pass" }, expected: true },
    { action: { type: "compact", outcome: "pass", instructions: "Keep decisions" }, expected: true },
    {
      action: { type: "message", outcome: "pass", message: "Now", delivery: "steer" },
      expected: true,
    },
    {
      action: {
        type: "message",
        outcome: "pass",
        message: "Later",
        delivery: "followUp",
        triggerTurn: true,
      },
      expected: true,
    },
    {
      action: { type: "message", outcome: "pass", message: "Next", delivery: "nextTurn" },
      expected: true,
    },
    {
      action: {
        type: "emit-custom-event",
        outcome: "pass",
        name: "example:event",
        data: { nested: [true, 1, null] },
      },
      expected: true,
    },
    { action: { type: "interrupt" }, expected: false },
    { action: { type: "interrupt", outcome: [] }, expected: false },
    { action: { type: "interrupt", outcome: "pass", code: [] }, expected: false },
    { action: { type: "interrupt", outcome: "patch" }, expected: false },
    { action: { type: "interrupt", outcome: "pass", code: 1 }, expected: false },
    { action: { type: "interrupt", outcome: "block", code: 0 }, expected: false },
    {
      action: {
        type: "message",
        outcome: "pass",
        message: "Invalid",
        delivery: "nextTurn",
        triggerTurn: true,
      },
      expected: false,
    },
    { action: { type: "interrupt", outcome: "pass", extra: true }, expected: false },
    { action: { type: "emit-custom-event", outcome: "pass", name: "   " }, expected: false },
  ];

  for (const [index, { action, expected }] of actionCases.entries()) {
    it(`keeps action variant ${index} aligned`, () => {
      const entry = {
        description: "d",
        event: "tool_call",
        action,
      };
      const schemaAccepts = validate({ local: { entry } });
      const runtimeAccepts = validateHookEntry(entry)?.kind === "hook";
      assert.equal(schemaAccepts, expected, JSON.stringify(validate.errors));
      assert.equal(runtimeAccepts, expected);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Runtime/schema parity for Catalog Entry identity and Presets
// ═══════════════════════════════════════════════════════════════════

describe("Catalog Entry runtime/schema parity", () => {
  for (const [label, name, expected] of [
    ["ordinary", "guard", true],
    ["empty", "", false],
    ["slash", "nested/guard", false],
    ["NUL", "nul\x00guard", false],
  ] as const) {
    it(`keeps ${label} names aligned`, () => {
      const config = {
        local: {
          [name]: { description: "d", event: "tool_call", shell: "true" },
        },
      };
      assert.equal(validate(config), expected, JSON.stringify(validate.errors));
      assert.equal(isValidEntryName(name), expected);
    });
  }

  it("accepts Hook References whose names use otherwise valid characters", () => {
    const preset = {
      description: "d",
      preset: ["local/local guard", "owner/repo/remote guard"],
    };
    assert.equal(validate({ local: { bundle: preset } }), true);
    assert.deepEqual(validateHookEntry(preset), { kind: "preset" });
  });

  it("rejects duplicate Preset references in schema and runtime validation", () => {
    const preset = {
      description: "d",
      preset: ["local/guard", "local/guard"],
    };
    assert.equal(validate({ local: { bundle: preset } }), false);
    assert.equal(validateHookEntry(preset), null);
  });

  it("accepts invocationId and rejects legacy runId in hook_result filters", () => {
    const entry = (filter: Record<string, string>) => ({
      description: "d",
      event: "hook_result",
      filter,
      shell: "true",
    });

    for (const [field, expected] of [
      ["invocationId", true],
      ["runId", false],
    ] as const) {
      const candidate = entry({ [field]: "^[0-9a-f-]+$" });
      assert.equal(validate({ local: { handler: candidate } }), expected);
      assert.equal(validateHookEntry(candidate)?.kind === "hook", expected);
    }
  });
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
            filter: { toolName: "read" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -qE \'\\.(env|pem|key)\' && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "default-based enablement example",
      config: {
        local: {
          "always-enabled": {
            description: "d",
            event: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
            default: true,
          },
          "opt-in": {
            description: "d",
            event: "tool_call",
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
      config: { local: { bad: { event: "tool_call", shell: "true" } } },
      expected: false,
    },

    {
      label: "missing required 'event'",
      config: { local: { bad: { description: "d", shell: "true" } } },
      expected: false,
    },

    {
      label: "missing required 'shell'",
      config: { local: { bad: { description: "d", event: "tool_call" } } },
      expected: false,
    },

    {
      label: "unknown property at hook level",
      config: {
        local: {
          bad: {
            description: "d",
            event: "tool_call",
            shell: "true",
            extraProp: "should not be here",
          },
        },
      },
      expected: false,
    },

    {
      label: "event value not in enum",
      config: { local: { bad: { description: "d", event: "invalid_event", shell: "true" } } },
      expected: false,
    },

    {
      label: "default is not boolean",
      config: {
        local: { bad: { description: "d", event: "tool_call", shell: "true", default: "yes" } },
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
      label: "accepts local section with valid hooks",
      config: { local: { guard: { description: "d", event: "tool_call", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts repo section with valid hooks",
      config: {
        "meffmadd/HooKit-rules": {
          "block-write": { description: "d", event: "tool_call", shell: "false" },
        },
      },
      expected: true,
    },

    {
      label: "accepts mixed local and repo sections",
      config: {
        local: { custom: { description: "d", event: "tool_call", shell: "true" } },
        "some/repo": { installed: { description: "d", event: "tool_call", shell: "false" } },
      },
      expected: true,
    },

    {
      label: "accepts $schema alongside sections",
      config: {
        $schema: "https://example.com/schema.json",
        local: { guard: { description: "d", event: "tool_call", shell: "true" } },
      },
      expected: true,
    },

    {
      label: "accepts repos array with valid entries",
      config: {
        repos: ["meffmadd/HooKit-rules"],
        local: { guard: { description: "d", event: "tool_call", shell: "true" } },
        "meffmadd/HooKit-rules": {
          block: { description: "d", event: "tool_call", shell: "false" },
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
      label: "accepts 'tool_call' as an Event",
      config: { local: { guard: { description: "d", event: "tool_call", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'tool_result' as an Event",
      config: { local: { guard: { description: "d", event: "tool_result", shell: "true" } } },
      expected: true,
    },

    {
      label: "tool_result with filter and when",
      config: {
        local: {
          "block-secrets-in-reads": {
            description: "d",
            event: "tool_result",
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
      label: "accepts 'turn_end' as an Event",
      config: { local: { guard: { description: "d", event: "turn_end", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'agent_settled' as an Event",
      config: { local: { guard: { description: "d", event: "agent_settled", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'session_before_switch' as an Event",
      config: { local: { guard: { description: "d", event: "session_before_switch", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'session_before_fork' as an Event",
      config: { local: { guard: { description: "d", event: "session_before_fork", shell: "true" } } },
      expected: true,
    },

    {
      label: "rejects 'session_shutdown' because it has no cancellation contract",
      config: { local: { guard: { description: "d", event: "session_shutdown", shell: "true" } } },
      expected: false,
    },

    {
      label: "accepts hook_result with its bounded filter",
      config: {
        local: {
          handler: {
            description: "d",
            event: "hook_result",
            filter: {
              event: "^hook_result$",
              hookRef: "^local/",
              invocationId: "^[0-9a-f-]+$",
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
      label: "rejects unknown hook_result outcome",
      config: {
        local: {
          handler: {
            description: "d",
            event: "hook_result",
            filter: { outcome: "error" },
            shell: "true",
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects regex syntax in exact hook_result outcome",
      config: {
        local: {
          handler: {
            description: "d",
            event: "hook_result",
            filter: { outcome: "p.*" },
            shell: "true",
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects string hook_result code filters",
      config: {
        local: {
          handler: {
            description: "d",
            event: "hook_result",
            filter: { code: "^1$" },
            shell: "true",
          },
        },
      },
      expected: false,
    },
    {
      label: "rejects unbounded hook_result filter fields",
      config: {
        local: {
          handler: {
            description: "d",
            event: "hook_result",
            filter: { originEvent: "tool_call" },
            shell: "true",
          },
        },
      },
      expected: false,
    },

    {
      label: "accepts 'agent_end' as an Event",
      config: { local: { guard: { description: "d", event: "agent_end", shell: "true" } } },
      expected: true,
    },

    {
      label: "agent_end with when and default",
      config: {
        local: {
          "check-git-clean": {
            description: "d",
            event: "agent_end",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
            filter: { toolName: [{ write: true }] },
            shell: "false",
          },
        },
      },
      expected: false,
    },

    // ── Hooks with owned Actions ───────────────────────────────

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
      label: `accepts owned Action variant ${index}`,
      config: {
        local: {
          action: {
            description: "d",
            event: "tool_call",
            filter: { toolName: "^bash$" },
            when: "true",
            action: { outcome: "pass", ...action },
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
            event: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
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
            event: "tool_call",
            action: { type: "interrupt", outcome: "pass", extra: true },
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
            event: "tool_call",
            action: {
              type: "emit-custom-event",
              outcome: "pass",
              name: "   ",
            },
          },
        },
      },
      expected: false,
    },
    {
      label: "accepts one Hook carrying both shell and Action",
      config: {
        local: {
          ambiguous: {
            description: "d",
            event: "tool_call",
            shell: "true",
            action: { type: "interrupt", outcome: "pass" },
          },
        },
      },
      expected: true,
    },
    {
      label: "rejects an inert entry without shell, action, or preset",
      config: {
        local: { inert: { description: "d", event: "tool_call" } },
      },
      expected: false,
    },
    {
      label: "accepts a hook_result Hook with an owned Action",
      config: {
        local: {
          action: {
            description: "d",
            event: "hook_result",
            filter: { outcome: ["block", "patch"], code: [1, null] },
            action: { type: "interrupt", outcome: "pass" },
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
            preset: ["local/block-rm-rf", "meffmadd/HooKit-rules/protect-env"],
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
      label: "rejects a preset carrying event (mutual exclusivity)",
      config: {
        local: { p: { description: "d", preset: [], event: "tool_call" } },
      },
      expected: false,
    },
    {
      label: "rejects a preset carrying when (hook-only)",
      config: {
        local: { p: { description: "d", preset: [], when: "true" } },
      },
      expected: false,
    },
    {
      label: "rejects a preset carrying filter (hook-only)",
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
          p: { description: "d", event: "tool_call", shell: "false", preset: ["local/a"] },
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
