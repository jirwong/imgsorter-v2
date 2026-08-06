# Contributing

Thanks for your interest in contributing to imgsorter-v2.

## Prerequisites

- Node.js 24.12.0 (see `.node-version` / `.nvmrc`)
- pnpm 11.20.0

## Setup

```bash
pnpm install   # installs deps and git hooks (Lefthook)
```

## Workflow

1. Create a feature branch from `main`.
2. Make changes in `src/`.
3. Run `pnpm check` — runs typecheck, lint, tests, and format check:

   ```bash
   pnpm check
   ```

   Or run them individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`.

4. Run `pnpm format` before committing if needed.

## Committing

- Follow [Conventional Commits](https://www.conventionalcommits.org/).
- Keep commits focused — one logical change per commit.
- Use the imperative mood, 50-char subject line max.
- The pre-commit hook runs oxlint + Prettier on staged files.

## CI

Pull requests and pushes to `main` run CI (typecheck, lint, format check, tests, coverage, build) and a gitleaks secret scan. All checks must pass before merging.
