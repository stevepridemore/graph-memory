import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_MEMORY_HOME } from "./config.js";

// ─── Event schema ─────────────────────────────────────────────────────────────
// One JSONL line per event, appended to logs/dream-audit.jsonl.
// Never throws — audit failures must not break the dream process.

interface BaseEvent {
  timestamp: string;
  /** Tenant id this event applies to. Required for multi-tenant isolation —
   *  every dream-process operation runs as some tenant, and audit log readers
   *  filter by tenant. */
  tenant_id: string;
}

export type DreamAuditEvent =
  | (BaseEvent & {
      event: "run_start";
      source: string;
      transcripts_pending: number;
      ingest_pending: number;
    })
  | (BaseEvent & {
      event: "run_end";
      source: string;
      duration_ms: number;
      transcripts_processed: number;
      ingest_processed: number;
      entities_created: number;
      edges_created: number;
      errors: number;
    })
  | (BaseEvent & {
      event: "transcript_start";
      session_id: string;
      file_path: string;
      line_count: number;
    })
  | (BaseEvent & {
      event: "transcript_end";
      session_id: string;
      entities_extracted: number;
      edges_created: number;
    })
  | (BaseEvent & {
      event: "transcript_skipped";
      session_id: string;
      file_path: string;
      reason: string;
    })
  | (BaseEvent & {
      event: "entity_created";
      name: string;
      entity_type: string;
      confidence: number;
      source_session: string;
    })
  | (BaseEvent & {
      event: "edge_created";
      from_name: string;
      to_name: string;
      relation: string;
      weight: number;
      source_session: string;
    })
  | (BaseEvent & {
      event: "edge_modified";
      from_name: string;
      to_name: string;
      relation: string;
      old_weight: number;
      new_weight: number;
    })
  | (BaseEvent & {
      event: "merge_flagged";
      entity_a: string;
      entity_b: string;
      reason: string;
    })
  | (BaseEvent & {
      event: "contradiction_found";
      entity_a: string;
      entity_b: string;
      relation: string;
      description: string;
    })
  | (BaseEvent & {
      event: "ingest_start";
      file_path: string;
    })
  | (BaseEvent & {
      event: "ingest_end";
      file_path: string;
      entities_extracted: number;
      edges_created: number;
    })
  | (BaseEvent & {
      event: "decay_applied";
      nodes_affected: number;
      edges_affected: number;
    })
  | (BaseEvent & {
      event: "format_warning";
      file_path: string;
      format_version: string;
      warnings: string[];
    })
  | (BaseEvent & {
      event: "error";
      context: string;
      message: string;
    });

// ─── Writer ───────────────────────────────────────────────────────────────────

const AUDIT_LOG = join(GRAPH_MEMORY_HOME, "logs", "dream-audit.jsonl");

export function appendAuditEvent(event: DreamAuditEvent): void {
  try {
    mkdirSync(join(GRAPH_MEMORY_HOME, "logs"), { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify(event) + "\n");
  } catch { /* never throw from audit */ }
}

/** Convenience wrapper — stamps timestamp automatically. */
export function auditEvent<T extends DreamAuditEvent["event"]>(
  eventType: T,
  data: Omit<Extract<DreamAuditEvent, { event: T }>, "event" | "timestamp">,
): void {
  appendAuditEvent({
    event: eventType,
    timestamp: new Date().toISOString(),
    ...data,
  } as unknown as DreamAuditEvent);
}
