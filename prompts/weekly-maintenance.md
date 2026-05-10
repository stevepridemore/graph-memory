# Graph Memory — Weekly Maintenance

You are running the weekly graph memory maintenance routine. Steps run in order; later steps depend on earlier ones succeeding.

The shape: **lock → backup → analyze → prune → report → email → unlock**. The backup is a safety net for the prune; if backup fails, prune does not run. Email is best-effort — a delivery failure logs an error but doesn't abort the release of the lock.

## Step 0: Acquire the maintenance lock (mutually-exclusive with the nightly dream)

The nightly dream and this weekly task both modify the graph; they share a lock file at `~/graph-memory/processed/dream.lock` so they never run concurrently.

Check for the lock file. If it exists **and** was created less than 2 hours ago, **abort immediately** — another dream or maintenance process is running. Log the abort to `~/graph-memory/logs/weekly-maintenance-errors.log` with timestamp + reason ("lock held by <source> at <timestamp>") and exit.

If no lock (or stale lock >2 hours), create the lock file:
```json
{
  "pid": <your process id or 0>,
  "timestamp": "<current ISO timestamp>",
  "source": "scheduled-weekly"
}
```

**You MUST release this lock (delete the file) when you finish, whether you succeed or fail.** Every exit path from this prompt — including the abort paths in step 1 (backup failed) and step 9 (prune sanity check tripped) — must delete the lock file before exiting.

## Step 1: Backup the graph (REQUIRED — abort all subsequent steps if this fails)

Call `graph_export` with:
- `keep: 14` (rolling retention — 14 most recent backups kept)
- `label: "weekly-pre-maintenance"` (so the filename clearly identifies these as weekly-routine backups)

Capture the returned `backup_file` path; later steps reference it.

If export fails (`isError`, missing `backup_file`, or `node_count` is 0):
- Append one line to `~/graph-memory/logs/weekly-maintenance-errors.log` with timestamp + error message
- Stop here — do not run any further steps. Do not run prune without a fresh backup.

## Step 2: Graph health overview

Call `graph_stats`. Capture:
- Total nodes and edges by type
- Average edge weight
- Orphaned nodes count
- Unresolved contradictions count
- Stale entries count
- Pending ingest documents

These numbers go into the report and are compared against last week's report for trend tracking.

## Step 3: Unresolved contradictions

Call `graph_contradictions`. For each:
- Classify as **genuine contradiction** (both can't be true) or **supersession** (one replaced the other over time)
- For supersessions: recommend `graph_relate` with `valid_at` to invalidate the old edge (the new bi-temporal supersession behavior handles this automatically when `valid_at` is supplied)
- For genuine contradictions: recommend which is more likely correct based on recency, weight, and source

Do not auto-resolve — surface for human review in the report.

## Step 4: Stale entities

Run via `graph_cypher`:

```cypher
MATCH (n:Entity)
WHERE n.confidence < 0.2 AND n.last_seen < datetime() - duration('P90D')
RETURN labels(n) AS types, n.id, n.name, n.confidence, n.last_seen
ORDER BY n.confidence ASC
LIMIT 30
```

For each, note remaining relationships (which would also disappear if pruned).

## Step 5: Orphaned nodes

```cypher
MATCH (n:Entity)
WHERE NOT (n)-[]-()
RETURN n.id, n.name, labels(n) AS types, n.confidence, n.last_seen
ORDER BY n.last_seen ASC
```

Flag for the report. The prune step (later) will pick these up if they're old enough; for newer orphans, recommend manual connection or deletion.

## Step 6: Weak clusters

```cypher
MATCH (n:Entity)-[r]-()
WITH n, max(r.weight) AS maxWeight, count(r) AS edgeCount
WHERE maxWeight < 0.3
RETURN n.id, n.name, labels(n) AS types, maxWeight, edgeCount
ORDER BY maxWeight ASC
LIMIT 20
```

These are entities that exist but are barely connected — knowledge that's fading or was never well-established.

## Step 7: Potential duplicates

Call `graph_merge_suggestions` with default settings to surface candidate duplicate pairs (uses embedding similarity + shared-neighbor overlap + name-token Jaccard).

For each pair, report the score and recommend whether to merge (via `graph_merge`) or alias (via `graph_relate ALIAS_OF`). Do not auto-merge.

## Step 8: Dream process health

Check `~/graph-memory/processed/manifest.json` and the recent entries in `~/graph-memory/logs/dream-audit.jsonl`:
- When was the most recent successful nightly dream?
- Any `error` events in the last 7 days?
- Any `format_warning` events (transcript format drift)?
- Any session ID in the manifest with `error` or stale `processed_at`?

## Step 9: Prune preview (sanity check before destructive step)

Call `graph_prune` with `mode: "preview"` (default thresholds: nodes < 0.1 confidence, edges < 0.05 weight, orphans older than 30 days).

Capture the returned `nodes_pruned`, `edges_pruned`, and `details` array.

**Sanity check:** if the preview shows more than 50 nodes to delete in one run, **abort the prune step**. Log a warning to `~/graph-memory/logs/weekly-maintenance-errors.log` with the count and the first 10 IDs. A sudden large prune count usually indicates either (a) a decay configuration change (b) a bug or (c) a one-time cleanup that should be reviewed manually before executing.

If the count is reasonable, proceed to step 10.

If `nodes_pruned + edges_pruned == 0`, skip step 10 (nothing to do) and note "no items to prune" in the report.

## Step 10: Execute prune

Call `graph_prune` with `mode: "execute"` (same default thresholds).

Verify the result matches the preview from step 9 (same counts, or very close — concurrent dream activity could shift things by a small margin). If the executed counts differ wildly from the preview, log a warning.

## Step 11: Write weekly report

Two outputs:

### A. Append a one-line summary to `~/graph-memory/logs/weekly-maintenance.log`

Format:
```
<ISO timestamp> | nodes=<N> edges=<N> pruned_nodes=<N> pruned_edges=<N> contradictions=<N> stale=<N> orphans=<N> backup=<filename>
```

### B. Write a detailed markdown report to `~/graph-memory/logs/weekly-reports/YYYY-MM-DD.md`

Use this template:

```markdown
# Weekly Graph Maintenance — YYYY-MM-DD

## Action Required
- [ ] Items needing manual attention (contradictions to resolve, duplicates to merge, etc.)

## Backup
- File: <backup_file>
- Nodes: <N> | Edges: <N>
- Retention: 14 most recent kept

## Graph Health
- Nodes: <N> total (breakdown by type)
- Edges: <N> total (breakdown by type)
- Average weight: X.XX
- Orphaned nodes: <N>
- Stale entities: <N>
- Unresolved contradictions: <N>
- Pending ingests: <N>

## Contradictions
For each: description, classification (genuine vs supersession), recommendation.

## Stale Entities
List with confidence + last_seen + remaining-relationships count.

## Orphaned Nodes
List with last_seen + recommendation (auto-pruned in step 10 if old enough; otherwise note).

## Weak Clusters
Entities barely connected.

## Potential Duplicates
Pairs with score + recommendation (merge vs alias vs leave).

## Dream Process Status
- Last successful run: timestamp
- Errors in last 7 days: count + summary
- Format warnings: count + summary
- Manifest health: any anomalies

## Prune Results
- Preview count: <N> nodes / <N> edges
- Executed count: <N> nodes / <N> edges
- Items removed: list of node IDs and what they were (so you can recover from the backup if needed)

## Comparison with Last Week
If a previous weekly report exists at `~/graph-memory/logs/weekly-reports/YYYY-MM-DD.md` (the previous Sunday):
- Δ nodes: +X / -Y
- Δ edges: +X / -Y
- New contradictions: N
- Resolved contradictions: N
- Notable trends

## Recommendations
Specific, actionable items for the upcoming week.
```

## Step 12: Email the report (best-effort)

Send the weekly report to the maintainer's email address via the Google Workspace CLI, with the report rendered as inline HTML so tables and headings are readable in Gmail. Set `MAINT_EMAIL` to the recipient address (kept out of this checked-in prompt; the scheduled-task copy hardcodes the actual address):

```sh
cd ~/graph-memory/logs/weekly-reports
HTML=$(PYTHONIOENCODING=utf-8 python -c "import markdown,sys; sys.stdout.reconfigure(encoding='utf-8'); print(markdown.markdown(open('<YYYY-MM-DD>.md',encoding='utf-8').read(), extensions=['extra','sane_lists']))")
gws gmail +send \
  --to "$MAINT_EMAIL" \
  --subject "Weekly Graph Maintenance — <YYYY-MM-DD> (<N> pruned, <M> action items)" \
  --body "$HTML" \
  --html
```

Where:
- `<YYYY-MM-DD>` is today's date matching the report filename
- `<N>` is `nodes_pruned` from step 10 (or 0 if step 10 was skipped)
- `<M>` is the count of unchecked items in the report's "Action Required" section
- The report markdown is converted to HTML via the Python `markdown` package (`extra` extension provides table support; `sane_lists` keeps the action-item checkboxes rendering correctly)
- `PYTHONIOENCODING=utf-8` + `sys.stdout.reconfigure` are required on Windows so unicode arrows (`↔`, `→`) in the report don't blow up the default cp1252 console codec
- No attachment — the HTML body is the deliverable. The report `.md` file remains on disk under `~/graph-memory/logs/weekly-reports/` for archive/grep

Prerequisite: `pip install markdown` (one-time, ~50KB pure-Python package). If the import fails, log a one-line error and skip the email — do NOT auto-install during the run.

This step is **best-effort**:
- If `gws gmail +send` exits non-zero (auth expired, network failure, quota exceeded, etc.), append an error line to `~/graph-memory/logs/weekly-maintenance-errors.log` with timestamp + the gws error output
- Do NOT abort the run — the report file is already written on disk; the email is purely a delivery-convenience layer
- Proceed to step 13 (release the lock) regardless

Common failure mode to recognize: `reauth related error (invalid_rapt)` means the gws OAuth refresh token needs human re-auth via `gws auth login`. Log it clearly so the next morning's report check makes the cause obvious.

## Step 13: Release the lock

Delete `~/graph-memory/processed/dream.lock`. This must happen on every exit path — successful completion, abort due to backup failure (step 1), abort due to prune-count sanity check (step 9), email failure in step 12, or any other failure. If the lock isn't released, future runs of either the nightly dream or the next weekly maintenance will see it as "held" until the 2-hour stale threshold expires.

## Rules

1. **Lock acquisition is mandatory.** Both the nightly dream and this weekly task share `~/graph-memory/processed/dream.lock`. If you can't acquire the lock (held by another process less than 2 hours old), abort. Never run graph-modifying operations concurrently with the nightly dream.
2. **Lock release is mandatory on every exit path.** Including aborts. A held-but-orphaned lock blocks the next 2 hours of scheduled runs.
3. **Backup is mandatory.** If step 1 fails, every subsequent step is skipped (but still release the lock before exiting). The whole point of the safety net is "prune only with a fresh backup as recovery option."
4. **Prune sanity check is mandatory.** Do not execute a prune of more than 50 nodes without manual review. The preview-then-execute split exists specifically to catch surprises.
5. **Do not auto-resolve contradictions.** Report them; let the human decide.
6. **Do not auto-merge duplicates.** Report them; let the human decide.
7. **Report is append-only history.** Never overwrite a previous weekly report. Each Sunday produces a new dated file.
8. **Audit trail.** Every modifying call (`graph_export`, `graph_prune`) should be logged via `graph_audit` with the appropriate event type so the dream-audit log captures the weekly maintenance activity alongside nightly extraction activity.
