# Database Schema

The SQLite database (default `local.db`) is created and managed by `DbService` in `src/services/db-service.ts`. It uses WAL journal mode and contains two tables.

## `entries`

Per-file metadata for every indexed file. One row per scanned file path.

| Column      | Type    | Nullable | Notes                                                                 |
| ----------- | ------- | -------- | --------------------------------------------------------------------- |
| `id`        | INTEGER | No       | Primary key, auto-increment                                           |
| `size`      | INTEGER | Yes      | File size in bytes                                                    |
| `directory` | TEXT    | Yes      | Parent directory of the file                                          |
| `extension` | TEXT    | Yes      | File extension (e.g. `.jpg`)                                          |
| `filename`  | TEXT    | Yes      | Base file name                                                        |
| `birthtime` | TEXT    | Yes      | File creation time, stored as an ISO 8601 string                      |
| `hash`      | TEXT    | Yes      | SHA-256 hash of the first/last 16 KB; `NULL` when hashing is disabled |
| `path`      | TEXT    | Yes      | Full file path; must be unique                                        |

- **Unique constraint:** `UNIQUE(path)`
- Inserts use `INSERT ... ON CONFLICT(path) DO UPDATE`, so re-scanning an existing path updates the row rather than inserting a duplicate.

### Indexes

| Index                   | Table     | Columns     |
| ----------------------- | --------- | ----------- |
| `idx_entries_filename`  | `entries` | `filename`  |
| `idx_entries_hash`      | `entries` | `hash`      |
| `idx_entries_directory` | `entries` | `directory` |

## `records`

Rebuilt summary table grouping `entries` rows by filename, size, and hash. Used to detect duplicates.

| Column        | Type    | Nullable | Notes                                                    |
| ------------- | ------- | -------- | -------------------------------------------------------- |
| `id`          | INTEGER | No       | Primary key, auto-increment                              |
| `filename`    | TEXT    | Yes      | Base file name                                           |
| `hash`        | TEXT    | Yes      | Content hash                                             |
| `count`       | INTEGER | Yes      | Number of `entries` rows in this group                   |
| `directories` | TEXT    | Yes      | JSON array of directories containing files in this group |
| `extension`   | TEXT    | Yes      | File extension (e.g. `.jpg`)                             |
| `size`        | INTEGER | Yes      | File size in bytes                                       |

- **Unique constraint:** `UNIQUE(filename, hash)`
- A "duplicate group" is a row with `count > 1` — the same filename, size, and hash verified in more than one directory.
- The table is fully deleted and rebuilt from `entries` by the records phase (`updateFileRecords`); `entries` rows with a `NULL` hash group under `NULL`.

### Indexes

| Index                  | Table     | Columns    |
| ---------------------- | --------- | ---------- |
| `idx_records_filename` | `records` | `filename` |
| `idx_records_hash`     | `records` | `hash`     |

## Relationship

- `records` is derived from `entries`; there is no foreign key between the tables.
- The records phase (`src/phases/records-phase.ts`) rebuilds `records` via the SQL grouping in `DbService.updateFileRecords()`:

```sql
SELECT hash, filename, size, extension,
       cast(json_group_array(distinct directory) as varchar) as directories,
       count(*) as row_count
FROM entries
GROUP BY hash, filename, size, extension
ORDER BY filename;
```

## Notes

- `birthtime` is a JS `Date` serialized with `toISOString()` on write and parsed back into a `Date` on read (see `DbService.insertFileInfo` / `mapEntry`).
- The `entries` schema is designed for 10k–100k files; indexes exist on `filename`, `hash`, and `directory` to support lookups by those columns.
