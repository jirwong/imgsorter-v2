# Basic TypeScript Template

[![CI](https://github.com/jirwong/basic-typescript-template/actions/workflows/ci.yml/badge.svg)](https://github.com/jirwong/basic-typescript-template/actions/workflows/ci.yml)

A minimal, opinionated TypeScript template for Node.js projects. Includes modern tooling for development, testing, and code quality.

## Quick Start

### Prerequisites

- **Node.js 24.12.0** (managed by `.node-version` and `.nvmrc`)
- **pnpm 11.20.0** (see `packageManager` in `package.json`)

### Setup

```bash
# Install dependencies
pnpm install

# This automatically installs git hooks via Lefthook
```

### Development

```bash
# Build and run once
pnpm dev

# Watch mode - rebuild and rerun on changes
pnpm dev:watch

# Type-check without building
pnpm typecheck

# Run tests
pnpm test

# Watch mode for tests
pnpm test:watch
```

## Available Commands

| Command              | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `pnpm dev`           | Run the TypeScript entry point with tsx     |
| `pnpm dev:watch`     | Watch src and re-run on changes             |
| `pnpm build`         | Compile TypeScript to JavaScript in `dist/` |
| `pnpm typecheck`     | Type-check without emitting code            |
| `pnpm lint`          | Run oxlint on src directory                 |
| `pnpm lint:fix`      | Run oxlint with auto-fix                    |
| `pnpm test`          | Run tests once with Vitest                  |
| `pnpm test:watch`    | Run tests in watch mode                     |
| `pnpm test:coverage` | Run tests and report code coverage          |
| `pnpm format`        | Format all code with Prettier               |
| `pnpm format:check`  | Check formatting without changes            |
| `pnpm check`         | Run typecheck, lint, test, and format check |

## Project Structure

```
.
├── src/                    # TypeScript source files
├── dist/                   # Compiled JavaScript (generated)
├── .node-version          # Node version for nodenv
├── .nvmrc                 # Node version for NVM
├── tsconfig.json          # TypeScript configuration
├── package.json           # Dependencies and scripts
├── prettier.config.mjs    # Prettier configuration
├── vitest.config.ts       # Vitest configuration
├── .oxlintrc.json         # oxlint configuration
├── .editorconfig          # Editor-agnostic settings
├── lefthook.yml           # Git hooks configuration
├── .gitattributes         # Line-ending normalization (LF)
├── .github/               # CI, Dependabot, and issue/PR templates
└── README.md              # This file
```

## Technology Stack

### Core

- **TypeScript 7.0.2** - Type-safe JavaScript with strict mode
- **esbuild 0.28.1** - Fast bundler and compiler
- **Node.js 24.12.0** - JavaScript runtime

### Development & Quality

- **Vitest 4.1.10** - Fast unit testing
- **oxlint 1.77.0** - Fast Rust-based linter
- **Prettier 3.9.6** - Code formatting
- **Lefthook 2.1.10** - Git hooks for automated checks
- **tsx 4.23.7** - Development auto-reload

### Runtime Dependencies

- **@t3-oss/env-core** - Type-safe environment variables
- **dotenv** - Load `.env` files
- **Zod** - TypeScript-first schema validation

## Code Quality

### Pre-commit Hooks

Git hooks are automatically installed when you run `pnpm install`:

- Runs oxlint on staged TypeScript files
- Formats code with Prettier
- Ensures code quality before commits

### Linting

```bash
# Check for issues
pnpm lint

# Auto-fix issues
pnpm lint:fix
```

### Type Safety

TypeScript strict mode is enabled. All files must have proper type annotations.

```bash
# Verify type safety
pnpm typecheck
```

### Testing

Unit tests use Vitest:

```bash
# Run all tests once
pnpm test

# Watch mode for development
pnpm test:watch
```

## Environment Variables

The project is configured for type-safe environment variables using `@t3-oss/env-core`:

1. Create a `.env` file in the project root
2. Define your environment variables
3. Use `dotenv` to load them
4. Access via validated schema

Example `.env`:

```
NODE_ENV=development
```

## Building for Production

```bash
# Compile TypeScript to JavaScript
pnpm build

# Output is in dist/index.js
```

## License

ISC
