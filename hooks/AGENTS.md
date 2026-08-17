# Core Hook authoring contract

These Catalog Entries are HooKit's stable first-party starter catalog. Keep
changes compatible with the support contract in `README.md`.

## Persisted shape

Every JSON file is a flat object of standard persisted Hooks and Presets. Names
must be unique across this directory. Do not introduce a Core-only format or
runtime path.

Descriptions are one-line statements of observable behavior. Keep rationale,
dependency notes, and implementation details in documentation and tests.

Do not set `default` to `true`. Every Core Catalog Entry remains opt-in.

Keep threshold families as explicit, complete persisted entries. Their repeated
limit commands are intentional remote catalog data; do not add a generator or
Core-only parameter format solely to deduplicate them.

## Dependencies and failure

General safety Hooks may rely on Node and the shell environment already needed
by HooKit, but not incidental tools such as Python, jq, or bash-deny. A Hook may
require tooling intrinsic to its domain: Git Hooks may require Git, npm Hooks
may require npm, and Pre-commit Hooks may require pre-commit.

Missing required tooling or processing must fail the Hook. Never use `when` to
probe command availability. `when` is only for intrinsic project context, such
as a project file that makes the policy applicable.

## Verification

Test observable behavior through the public Hook Evaluation interface. Validate
the complete catalog through the shared schema and Hook Catalog, exercise
Preset installation through the install workflow, and keep the npm artifact
free of `hooks/` content. Do not copy shell or Filter semantics into a separate
test harness.
