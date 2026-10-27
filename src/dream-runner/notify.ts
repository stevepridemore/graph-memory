import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile } from "./api-key.js";

// Email from the runner itself, after a run: the weekly report, and an alert
// when a run doesn't finish cleanly. The model never gets a mail tool. Mail
// goes through gws-mcp's send-only notify listener (POST /notify with a shared
// token), which sends from a fixed account to a fixed recipient. The runner
// picks neither, so it holds no Gmail credential.

export interface MailSettings {
  url: string;
  tokenFile: string;
}

/** Null when email isn't set up (no notify URL or token file). */
export function loadMailSettings(env: NodeJS.ProcessEnv = process.env): MailSettings | null {
  const url = env.DREAM_NOTIFY_URL?.trim();
  const tokenFile = env.DREAM_NOTIFY_TOKEN_FILE?.trim();
  if (!url || !tokenFile) return null;
  return { url, tokenFile };
}

export interface Mail {
  subject: string;
  text: string;
}

export type SendFn = (mail: Mail) => Promise<void>;

/** gws-mcp caps the body at 200 KB; trim from the top so the end survives. */
const MAX_TEXT = 190 * 1024;

export function notifySender(settings: MailSettings, fetchFn: typeof fetch = fetch): SendFn {
  return async (mail) => {
    const token = readSecretFile(settings.tokenFile, "DREAM_NOTIFY_TOKEN_FILE", /^(?:export\s+)?\w*TOKEN\s*=\s*(.+)$/);
    const text = mail.text.length > MAX_TEXT ? "[…trimmed]\n" + mail.text.slice(-MAX_TEXT) : mail.text;
    const res = await fetchFn(settings.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ subject: mail.subject.slice(0, 200), text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
      throw new Error(`notify returned ${res.status}${detail ? `: ${detail}` : ""}`);
    }
  };
}

export interface RunSummaryForMail {
  job: "nightly" | "weekly";
  outcome: string;
  started: Date;
  turns: number;
  costUsd: number;
  logPath: string;
  graphHome: string;
  model?: string;
  summary?: string;
  stats?: { sessions: number; entities: number; edges: number };
  pending?: { newTranscripts: number; grownTranscripts: number; ingestFiles: number };
}

/**
 * What to send for a finished run:
 *  - nightly, completed or nothing pending → a summary with the cost
 *  - weekly, completed → the report it wrote this run, with the cost on top
 *  - any job, other outcome (error, budget, turn limit, refusal, lock held) → an alert with the log's tail
 * Every mail carries this run's cost and the month's API spend so far.
 */
export function mailForRun(run: RunSummaryForMail): Mail | null {
  const date = localDate(run.started);
  const cost = `$${run.costUsd.toFixed(2)}`;
  const header = costHeader(run);

  if (run.job === "weekly" && run.outcome === "completed") {
    const report = newestReport(join(run.graphHome, "logs", "weekly-reports"), run.started);
    if (report) {
      const action = (report.text.match(/^- \[ \]/gm) ?? []).length;
      return {
        subject: `Weekly Graph Maintenance — ${date} (${action} action item${action === 1 ? "" : "s"}, ~${cost})`,
        text: `${header}\n\n---\n\n${report.text}\n\n---\nReport file: ${report.path}\n`,
      };
    }
    return alert(run, date, header, "The weekly run finished but wrote no report this run.");
  }

  if (run.job === "nightly" && run.outcome === "nothing_pending") {
    return {
      subject: `Graph dream — ${date}: nothing new (~${cost})`,
      text: `${header}\n\nNo new or grown transcripts and no ingest files, so no API call was made.\n`,
    };
  }

  if (run.job === "nightly" && run.outcome === "completed") {
    const st = run.stats ?? { sessions: 0, entities: 0, edges: 0 };
    const p = run.pending;
    const lines = [
      header,
      "",
      `Sessions processed: ${st.sessions}`,
      `Entities extracted: ${st.entities}`,
      `Edges created: ${st.edges}`,
      ...(p ? [`Found pending: ${p.newTranscripts} new, ${p.grownTranscripts} grown transcripts, ${p.ingestFiles} ingest files`] : []),
      ...(run.summary ? ["", "Dream summary:", run.summary] : []),
      "",
      `Log: ${run.logPath}`,
    ];
    return {
      subject: `Graph dream — ${date}: ${st.sessions} session${st.sessions === 1 ? "" : "s"}, ${st.entities} entities, ${st.edges} edges (~${cost})`,
      text: lines.join("\n") + "\n",
    };
  }

  return alert(run, date, header);
}

/** "Cost: ~$0.79 (18 turns, claude-opus-5-5)" plus the month's spend from runs.jsonl. */
function costHeader(run: RunSummaryForMail): string {
  const model = run.model ? `, ${run.model}` : "";
  const lines = [`Cost: ~$${run.costUsd.toFixed(2)} (${run.turns} turn${run.turns === 1 ? "" : "s"}${model})`];
  const month = monthSpend(join(run.graphHome, "logs", "dream-runner", "runs.jsonl"), run.started);
  if (month) {
    lines.push(`API spend this month: ~$${month.total.toFixed(2)} over ${month.runs} run${month.runs === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

/** Sum of estimated_cost_usd for runs started in the same local calendar month. */
export function monthSpend(runsPath: string, now: Date): { total: number; runs: number } | null {
  let raw: string;
  try {
    raw = readFileSync(runsPath, "utf-8");
  } catch {
    return null;
  }
  let total = 0;
  let runs = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { started?: string; estimated_cost_usd?: number };
      const d = r.started ? new Date(r.started) : null;
      if (!d || d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) continue;
      total += Number(r.estimated_cost_usd ?? 0);
      runs++;
    } catch { /* skip a bad line */ }
  }
  return { total, runs };
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function alert(run: RunSummaryForMail, date: string, header: string, note?: string): Mail {
  let tail = "";
  try {
    tail = readFileSync(run.logPath, "utf-8").split("\n").slice(-40).join("\n");
  } catch { /* no log */ }
  const what: Record<string, string> = {
    error: "failed with an error",
    budget_stopped: "stopped at its budget; the rest carries to the next run",
    turn_limit: "stopped at the turn limit",
    refused: "was declined by the model",
    locked: "didn't run: dream.lock was held by another run",
  };
  return {
    subject: `graph-memory ${run.job} run ${run.outcome} — ${date}`,
    text:
      `The ${run.job} run ${what[run.outcome] ?? `ended with outcome ${run.outcome}`}.\n` +
      (note ? `${note}\n` : "") +
      `\n${header}\n\nLog: ${run.logPath}\n\n${tail}\n`,
  };
}

function newestReport(dir: string, since: Date): { path: string; text: string } | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .filter((f) => f.mtime >= since.getTime() - 1000)
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return { path: files[0].path, text: readFileSync(files[0].path, "utf-8") };
  } catch {
    return null;
  }
}
