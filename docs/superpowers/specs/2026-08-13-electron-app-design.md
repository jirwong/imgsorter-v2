# imgsorter-v2 Electron App — Design & Google Stitch Prompt

Date: 2026-08-13

## Goal

Design a GUI for imgsorter-v2 — an Electron app (web-first design for Google
Stitch) that lets the user:

1. Identify which files are duplicated (and where every copy lives).
2. Identify which files are NOT duplicated (the unique files).
3. See what the files are (browse, preview, and inspect metadata).

Deliverable is a **single comprehensive prompt** for Google Stitch that produces
a consistent, dark, Shadcn-based UI for the whole app.

## Context

imgsorter-v2 is a TypeScript/Node.js CLI that indexes local files into a SQLite
database:

- **Scan** — recursively index files matching configured extensions into an
  `entries` table (filename, size, extension, birthtime, path, and a fast
  edge-based SHA-256 hash of the first/last 16 KB).
- **Resync** — remove stale entries for deleted/moved files.
- **Records** — rebuild a summary `records` table grouping files by filename,
  size, and hash.

The existing `Runner` class runs the phases and is already usable as a library
(e.g. from Electron). Progress flows through a `ProgressEmitter` as typed events
(`phaseStart`, `directoryStart`, `file`, `counts`) and cancellation is supported
cooperatively via an AbortController signal.

The user's library is roughly **10k–100k files** across a few top-level
directories. The app must handle that scale.

## Decisions (from brainstorm)

| Decision           | Choice                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Approach           | **A — Sidebar dashboard app** (4 sections: Overview, Duplicates, Unique Files, Browse)   |
| App scope          | **Visualize + control** — view DB contents AND trigger scans/resync/records from the UI  |
| Hero workflow      | Duplicates review AND general browse — both equally first-class                          |
| Duplicate grouping | **By content** (by hash), regardless of filename                                         |
| File actions       | Open / reveal in Explorer, preview inline, export report (CSV/JSON) — **no delete/move** |
| Metadata display   | Rich details panel on selection                                                          |
| Unique files       | Dedicated browsable unique-files view                                                    |
| Navigation         | Left sidebar tabs                                                                        |
| Overview           | Summary cards + last-run status + storage-by-directory                                   |
| Data scale         | Tens of thousands → virtualized lists, lazy thumbnails                                   |
| Scan UX            | Live progress + cancel button                                                            |
| Visual style       | Modern dark media browser (Lightroom/Photos aesthetic)                                   |
| Component system   | **Shadcn/UI** (Radix primitives + Tailwind), **dark-only** for v1                        |
| Prompt style       | **Single comprehensive prompt** (not per-screen)                                         |

## Architecture

Single-page Electron app (web-first design for Stitch) with a left sidebar nav,
a shared top bar, and a bottom status bar. All four views share common chrome:

```
┌────────────────────────────────────────────────────────────┐
│  Sidebar      │  Top bar: global search, dir filter, scan  │
│  (app icon,   │  button, live scan status                  │
│  scan button, ├────────────────────────────────────────────┤
│  nav items)   │                                            │
│               │  View content                              │
│  • Overview   │   (changes per section)                    │
│  • Duplicates │                                            │
│  • Unique     ├────────────────────────────────────────────┤
│  • Browse     │  Bottom status bar: db stats, last run     │
└────────────────────────────────────────────────────────────┘
```

### Data source

- All four views are **read-only** against the SQLite `entries` table.
- "Group by content" = group `entries` rows by hash. Computed in SQL
  (`SELECT path, filename, size, birthtime, extension, hash FROM entries ORDER BY hash`)
  then grouped; a second query filters to hash-count == 1 for the unique view.
- The `records` table is still rebuilt by the records phase, but the UI does not
  depend on it for content grouping.
- **Keeper selection is UI state only** — nothing is written back to the DB.

### Scan control

- Sidebar/top-bar scan button runs the enabled phases (scan → resync → records)
  via the existing `Runner`.
- Per-file progress surfaces through the existing `ProgressEmitter` into the
  top-bar progress indicator; a cancel button wires to the existing
  AbortController pattern.
- The app remains fully usable while a scan runs; DB-read views refresh when a
  phase completes.

### Thumbnails & performance

- **Lazy-loaded** on-demand thumbnails (`file://` load for local images, or
  Electron `nativeImage`), cache-backed (keyed on path + mtime), virtualized so
  only visible items load.
- **Virtualized lists/grids everywhere** for 10k+ files
  (`@tanstack/react-virtual`), debounced search, incremental DB reads.

## View specifications

### App shell

- **Left sidebar:** app icon/title, scan button, nav items (Overview,
  Duplicates, Unique Files, Browse).
- **Top bar:** global text search, directory filter dropdown, extension filter,
  scan status/progress.
- **Bottom status bar:** database stats (total files, total size), last run
  summary (phases, timestamps, counts, warnings).

### Overview

- **Summary cards:** total files, total size, duplicate groups, duplicate files,
  wasted space (sum of `(count-1) × size` over duplicate groups), unique files.
- **Last run status:** which phases ran, timestamps, per-phase counts and
  elapsed time, any warnings.
- **Storage by directory:** horizontal bars (or donut) showing file count + size
  per top-level configured directory.

### Duplicates

- **Primary view:** list of duplicate groups, each a row with a **stacked
  thumbnail** (first N thumbnails overlaid), group count, total wasted space,
  and a chevron to expand.
- **Expanded group:** every copy as a row with thumbnail, filename, directory,
  size, birthtime, hash. **Select one as "keeper"** — the rest are highlighted
  as candidates.
- Grouping is **by content (hash)**. Sub-filter by directory/extension via the
  top bar.
- **Actions per file:** reveal in Explorer, open, preview.
- **Export:** current duplicate-group results → CSV/JSON via save dialog.

### Unique Files

- Grid (or list) of files that appear exactly once (hash-count == 1).
- Same thumbnail, metadata columns, reveal/preview actions, and
  directory/extension filtering.
- Purpose: confirm nothing is missing from the library.

### Browse

- Full file browser across all entries: **grid of thumbnails** with **list view
  toggle**, sortable columns (name, size, birthtime, extension).
- Files belonging to a duplicate group get a **badge/overlay** ("×2", "×3");
  clicking a badge jumps to that group in the Duplicates view.
- The "see what the files are" view.

### Shared pieces

- **Details panel** (right slide-over `Sheet`): full path, size, extension,
  birthtime, hash, thumbnail preview, "Reveal in Explorer" + "Open" buttons.
- **Empty/loading/error states:** friendly empty states, loading skeletons for
  thumbnails, error states for unreadable files.

## Error handling

- **Unreadable files** → placeholder tile + warning icon; details panel notes
  the error; never blocks the view.
- **Scan failure / per-directory errors** → surfaced in top-bar status and
  collected in Overview "last run" (mirrors CLI: warnings don't fail the run).
- **DB locked / busy** (concurrent scan + read) → reads retry briefly or show a
  "refreshing…" state; scan and reads serialize where needed.
- **Cancel** → AbortController cancels cooperatively; partial results from a
  cancelled scan are discarded or marked stale.

## Design language

- **Component system:** Shadcn/UI (Radix primitives + Tailwind), **dark-only**.
- Colors as **CSS variables** (Shadcn theming: `--background`, `--foreground`,
  `--card`, `--card-foreground`, `--primary`, `--secondary`, `--muted`,
  `--accent`, `--destructive`, `--border`, `--input`, `--ring`), not arbitrary
  hexes.
- **Aesthetic:** modern dark media browser (Lightroom/Photos) — thumbnail-
  centric, generous spacing, muted backgrounds with accent highlights.
- **Single fixed palette and type scale** reused across all screens.
- **Component mapping:**
  - Sidebar → Shadcn `Sidebar` / `SidebarProvider`
  - Summary cards → Shadcn `Card`
  - Duplicates + Browse lists → Shadcn `Table` with expandable rows
  - Search / filtering → Shadcn `Command` (palette) + `DropdownMenu` / `Select`
  - Details panel → Shadcn `Sheet` (right slide-over)
  - Tabs/toggles → Shadcn `Tabs`, `Switch`, `Button` variants
  - Progress/status → Shadcn `Progress` + `Badge`
  - Errors → Shadcn `Sonner`/`Toast`
- **Where Shadcn doesn't cover a need, use Radix primitives directly** — e.g.
  virtualized grids use `@tanstack/react-virtual`; custom interactive behaviors
  use the appropriate Radix primitive.

## Google Stitch prompt

A single comprehensive prompt that produces the entire app design as one
consistent dark design system.

### Prompt text

---

Design a complete, single-page desktop web app UI called **imgsorter-v2** — a
media-file duplicate finder and browser. It indexes a local media library
(photos/videos) into a SQLite database and lets the user spot duplicate files,
spot unique files, and browse everything. The app is built with **React +
Shadcn/UI components (Radix primitives + Tailwind)** and targets a **dark-only**
theme. It must scale to tens of thousands of files, so all long lists and
thumbnail grids must be **virtualized** and thumbnails **lazily loaded**.

**Goal of the app:** (1) identify which files are duplicated and where every
copy lives, (2) identify which files are unique, (3) browse and inspect what the
files are.

### Data schema

The app reads from a SQLite database (default `local.db`) with two tables. All
screens render data sourced from these tables. Show the exact column values
described here — do not invent fields.

**Table `entries`** — one row per indexed file:

| Column      | Type    | Nullable | Notes                                                                 |
| ----------- | ------- | -------- | --------------------------------------------------------------------- |
| `id`        | INTEGER | No       | Primary key, auto-increment                                           |
| `size`      | INTEGER | Yes      | File size in bytes                                                    |
| `directory` | TEXT    | Yes      | Parent directory of the file                                          |
| `extension` | TEXT    | Yes      | File extension (e.g. `.jpg`)                                          |
| `filename`  | TEXT    | Yes      | Base file name                                                        |
| `birthtime` | TEXT    | Yes      | File creation time, ISO 8601 string                                   |
| `hash`      | TEXT    | Yes      | SHA-256 hash of the first/last 16 KB; `NULL` when hashing is disabled |
| `path`      | TEXT    | Yes      | Full file path; must be unique                                        |

**Table `records`** — rebuilt summary grouping `entries` by filename, size, and
hash; used to detect duplicates:

| Column        | Type    | Nullable | Notes                                                    |
| ------------- | ------- | -------- | -------------------------------------------------------- |
| `id`          | INTEGER | No       | Primary key, auto-increment                              |
| `filename`    | TEXT    | Yes      | Base file name                                           |
| `hash`        | TEXT    | Yes      | Content hash                                             |
| `count`       | INTEGER | Yes      | Number of `entries` rows in this group                   |
| `directories` | TEXT    | Yes      | JSON array of directories containing files in this group |
| `extension`   | TEXT    | Yes      | File extension (e.g. `.jpg`)                             |
| `size`        | INTEGER | Yes      | File size in bytes                                       |

A "duplicate group" is a `records` row with `count > 1` — the same filename,
size, and hash verified in more than one directory. Note: the app's Duplicates
screen additionally groups by content hash alone, so files with identical
content but different names are also shown together.

### App layout (shared chrome)

A three-region layout used by every screen:

- **Left sidebar** — app icon + title, a prominent "Scan" button with live
  progress, and nav items: **Overview**, **Duplicates**, **Unique Files**,
  **Browse**.
- **Top bar** — global text search, a directory filter dropdown, an extension
  filter, and a scan status/progress indicator.
- **Bottom status bar** — database stats (total files, total size) and last run
  summary (phases, timestamps, counts, warnings).

### Design language

Use Shadcn's dark theme with colors defined as CSS variables (`--background`,
`--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`,
`--border`, `--ring`), not arbitrary hex values. Aesthetic: a modern, dark
media-browser like Lightroom or Google Photos — thumbnail-centric, muted
backgrounds, restrained accent color, generous spacing, a single fixed type
scale reused everywhere. Where Shadcn lacks a needed component, use the
underlying **Radix primitive** directly.

### Screens

Design all four screens in the same visual language.

**1. Overview**

- Summary cards: total files, total size, duplicate groups, duplicate files,
  wasted space (bytes that could be freed), unique files.
- Last run status: which phases ran, when, per-phase counts and elapsed time,
  any warnings.
- Storage by directory: bars (or donut) showing file count and size per
  top-level directory.

**2. Duplicates**

- A list of duplicate groups (files grouped by content/hash). Each row: a
  stacked thumbnail (several thumbnails overlaid), the group's file count,
  total wasted space, and an expand chevron.
- Expanding a group reveals every copy as a row with thumbnail, filename,
  directory, size, birthtime, and hash. The user can mark one copy as the
  **keeper**; the remaining copies are visually highlighted as candidates.
- Each file row offers: preview, open, reveal in file explorer.
- An **Export** button exports the current duplicate groups to CSV or JSON.
- Support filtering by directory and extension.

**3. Unique Files**

- A grid (or list) of files that exist exactly once. Same thumbnail +
  metadata columns, preview/open/reveal actions, and directory/extension
  filtering.

**4. Browse**

- The full file browser: a thumbnail grid with a list-view toggle, sortable by
  name, size, birthtime, and extension.
- Files that belong to a duplicate group carry a badge/overlay (e.g. "×2");
  clicking the badge jumps to that group in the Duplicates screen.

**Shared:** a right-side details panel (slide-over) showing full path, size,
extension, birthtime, hash, and a thumbnail preview, with "Reveal in Explorer"
and "Open" buttons. Every screen needs distinct loading, empty, and error
states (e.g. thumbnail loading skeletons, friendly empty states, placeholder
tiles for unreadable files).

### Component mapping (must use these Shadcn components)

- Sidebar → `Sidebar` / `SidebarProvider`
- Summary cards → `Card`
- Duplicates + Browse lists → `Table` with expandable rows
- Global search → `Command`
- Filters → `DropdownMenu` / `Select`
- Details panel → `Sheet` (right slide-over)
- View toggles → `Tabs` / `Switch`
- Scan progress → `Progress` + `Badge`
- Errors → `Sonner`/`Toast`
- Virtualized grids/lists → `@tanstack/react-virtual` (with Radix primitives
  where needed)

Deliver the full app as one cohesive, consistent dark design system. All four
screens must share the same sidebar, top bar, bottom bar, spacing, palette,
type scale, and component usage.

---

## Out of scope (v1)

- Delete / move-to-folder file actions.
- Light mode.
- Per-screen separate prompts (superseded by the single comprehensive prompt).
- Editing DB rows or config from the UI.

## Testing

- Web prototype: React + Vitest for components (view rendering, filters, keeper
  selection, empty states); four self-contained views each get focused tests.
- DB read layer: unit tests against a real SQLite fixture DB (same schema as
  the CLI's) with seeded duplicate/unique data.
- Progress/cancel: test the scan-status component against a mocked runner.
- Manual verification pass in Electron against a real copy of the library.
