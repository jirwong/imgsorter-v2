# AGENTS.md / CLAUDE.md Consolidation Design

Date: 2026-08-12

## Objective

Consolidate `AGENTS.md` and `CLAUDE.md` into a single source of guidance. The
merged content lives in **`AGENTS.md`** (the cross-tool standard — opencode and
most AI agents read it by default); **`CLAUDE.md`** becomes a one-line pointer
stub so tools that look for that specific name still find something. This
eliminates the current duplication/drift between the two files.

## Context

Both files overlap heavily (Quick Commands, Project Structure, Technology
Stack, git/format conventions) and were both last edited in PR #29 to reflect
the phased runner architecture. They differ in emphasis:

- **AGENTS.md** (the base): more rigorous. Full project-structure tree, a
  Technology Stack version list, and a `Conventions` section (TypeScript
  strict rules, code style, testing, git, configuration) plus a `Workflow`.
- **CLAUDE.md**: looser. A shorter structure bullet list, and a few details
  AGENTS.md lacks: `@types/node 24.13.3`, `zod 4.4.3` (vs AGENTS' "zod 4.x"),
  the esbuild `--packages=external` detail, `.node-version` / `.nvmrc` in the
  structure, `pnpm prepare` (hooks auto-install on `pnpm install`), commit
  body wrap at 72 chars, and the `.prettierignore` note.

## Chosen Approach

**AGENTS.md as the merged file; CLAUDE.md reduced to a pointer stub.**

Rejected alternatives:

- **Consolidate into CLAUDE.md** — wrong default: opencode (the active agent)
  reads AGENTS.md.
- **Delete CLAUDE.md entirely** — tools that look for that specific filename
  would find nothing; a stub preserves that discovery path.

## Design

### Merged `AGENTS.md`

Structure, using the current AGENTS.md skeleton:

1. **Quick Commands** — unchanged (both files list the same commands; CLAUDE's
   list is a subset, so nothing to fold in).
2. **Project Structure** — current tree, plus the two files CLAUDE lists that
   AGENTS omits: `.node-version` (Node version for nodenv) and `.nvmrc` (Node
   version for NVM).
3. **Technology Stack** — current AGENTS list as base, with these folds from
   CLAUDE:
   - Add `@types/node 24.13.3` (type definitions for Node.js APIs).
   - Change `zod 4.x` → `zod 4.4.3`.
   - Clarify the esbuild line to note `--packages=external` keeps native
     modules unbundled.
4. **Conventions** — keep AGENTS' version wholesale (TypeScript, Code Style,
   Testing, Git, Configuration). Fold the one missing git detail from CLAUDE
   into the Git section: commit body wraps at 72 characters.
5. **Workflow** — keep AGENTS' 6-step workflow; add the `pnpm prepare` hooks
   note from CLAUDE: hooks auto-install on `pnpm install`.
6. **New "Code Formatting" section** (from CLAUDE) — `.prettierignore` is
   respected; `pnpm format` / `pnpm format:check` per repo scripts.

### `CLAUDE.md` stub

```markdown
# CLAUDE.md

This file is a pointer. The repository's agent guidance lives in `AGENTS.md`:
read that file for commands, project structure, conventions, and workflow.
```

### Content dropped

- CLAUDE's intro line ("migrated from imgsorter-utils onto a modern TypeScript
  template") — historical, not guidance.
- CLAUDE's duplicate quick-command descriptions and duplicate Technology
  Stack entries (Lefthook, esbuild version already present in AGENTS).
- CLAUDE's redundant Git Commits section — superseded by AGENTS' Git
  conventions, with the 72-char wrap detail folded in.

## Verification

- `pnpm format:check` passes (both files are prettier-formatted markdown).
- No other file references `CLAUDE.md`/`AGENTS.md` content that would break
  (grep: only a historical plan doc mentions them).

## Out of Scope

- Changes to README.md or CONTRIBUTING.md.
- Renaming either file to a non-standard name.
