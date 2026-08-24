# Core Hooks

This directory is HooKit's stable, first-party starter catalog. Its canonical
Hook Source is `meffmadd/HooKit`.

Core Catalog Entries are ordinary remote repository content. Install them with
`/hooks install`, review their shell commands, and enable only the policies you
want. They are not bundled in the npm package and none are enabled by default.

## Support contract

A Core Catalog Entry has:

- a stable source-qualified identity and stable documented behavior;
- deterministic, fail-closed behavior when required processing or tooling is
  unavailable;
- no incidental runtime dependency such as Python, jq, or bash-deny;
- schema and Hook Catalog validation;
- behavior tests through HooKit's public Hook Evaluation interface; and
- compatibility checks in HooKit's root quality gate.

Git Hooks require Git. npm Hooks require npm. Pre-commit Hooks require
pre-commit. Precondition commands describe project context; they do not hide
missing required tools.

Specialized, platform-specific, dependency-heavy, and incubating Hooks live in
[HooKit Extras](https://github.com/meffmadd/HooKit-extras).

## Catalog

### General safety

- `only-md`
- `no-env-access`
- `paths-in-cwd`
- `write-new-files-only`
- `no-env-secrets-in-output`

### Read-result thresholds

- `read-max-500-chars`
- `read-max-10000-chars`
- `read-max-20000-chars`
- `read-max-50000-chars`
- `read-max-100000-chars`

### Pi tool controls

- `block-read`
- `block-bash`
- `block-edit`
- `block-write`
- `block-grep`
- `block-find`
- `block-ls`
- `read-only` (Preset)

### Git policies

- `git-diff-check`
- `require-no-change`
- `require-more-deletions`
- `diff-max-10-lines`
- `diff-max-50-lines`
- `diff-max-100-lines`
- `diff-max-250-lines`
- `diff-max-500-lines`
- `diff-max-1000-lines`
- `diff-max-2000-lines`
- `diff-max-5000-lines`

The line policies count staged and unstaged tracked changes from `git diff HEAD`.
They ignore untracked files; use `require-no-change` when any working-tree change
must fail.

### npm workflow gates

- `npm-test`
- `npm-lint`
- `npm-build`
- `npm-typecheck`

### Pre-commit workflow gates

- `pre-commit-run`
- `pre-commit-run-all-files`

These Hooks apply when `.pre-commit-config.yaml` exists at the project root.

## Promotion

Core promotion requires an explicit compatibility and support review. The
initial catalog is the seed set; a future process will define incubation and
graduation from HooKit Extras.
