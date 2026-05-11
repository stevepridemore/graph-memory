---
name: graph-backup
description: Export the memory graph to a timestamped JSONL backup file. Use before risky operations or on demand.
triggers:
  - /graph-backup
---

# Graph Backup

Export the memory graph to a backup file.

## Steps

1. Call `graph_export` with no arguments (or pass `label` for a named backup, e.g. `label: "pre-prune"`).

2. Report the result to the user:
   - Backup file path
   - Node and edge counts
   - File size
   - How many old backups were pruned
   - How many are retained

3. If the export fails, report the error clearly and suggest checking whether the Docker container is running (`docker ps`).

## Example output

```
Backup complete:
  File: /root/graph-memory/backups/backup-2026-05-05T22-00-00.jsonl
  297 nodes, 418 edges
  42 KB
  Retained: 7 backups, pruned: 0
```
