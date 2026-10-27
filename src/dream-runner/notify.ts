import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { readSecretFile } from "./api-key.js";

// Email from the runner itself, after a run: the weekly report, and an alert
// when a run doesn't finish cleanly. The model never gets a mail tool. Uses
// plain SMTP (Gmail with an app password by default), so it doesn't depend on
// any OAuth sign-in staying fresh.

export interface MailSettings {
  to: string;
  user: string;
  passwordFile: string;
  host: string;
  port: number;
}

/** Null when email isn't set up (no recipient, sender or password file). */
export function loadMailSettings(env: NodeJS.ProcessEnv = process.env): MailSettings | null {
  const to = env.DREAM_ALERT_TO?.trim();
  const user = env.DREAM_SMTP_USER?.trim();
  const passwordFile = env.DREAM_SMTP_PASSWORD_FILE?.trim();
  if (!to || !user || !passwordFile) return null;
  return {
    to,
    user,
    passwordFile,
    host: env.DREAM_SMTP_HOST?.trim() || "smtp.gmail.com",
    port: Number(env.DREAM_SMTP_PORT?.trim() || 465),
  };
}

export interface Mail {
  subject: string;
  text: string;
}

export type SendFn = (mail: Mail) => Promise<void>;

export function smtpSender(settings: MailSettings): SendFn {
  return async (mail) => {
    const pass = readSecretFile(settings.passwordFile, "DREAM_SMTP_PASSWORD_FILE", /^(?:export\s+)?\w*PASSWORD\s*=\s*(.+)$/);
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      auth: { user: settings.user, pass },
    });
    await transport.sendMail({ from: settings.user, to: settings.to, subject: mail.subject, text: mail.text });
  };
}

/** Outcomes that mean "nothing to tell you": a normal run or a quiet night. */
const QUIET = new Set(["completed", "nothing_pending"]);

export interface RunSummaryForMail {
  job: "nightly" | "weekly";
  outcome: string;
  started: Date;
  turns: number;
  costUsd: number;
  logPath: string;
  graphHome: string;
}

/**
 * What to send for a finished run, if anything:
 *  - weekly, completed → the report it wrote this run
 *  - any job, other outcome (error, budget, turn limit, refusal, lock held) → an alert with the log's tail
 */
export function mailForRun(run: RunSummaryForMail): Mail | null {
  const date = run.started.toISOString().slice(0, 10);
  const cost = `~$${run.costUsd.toFixed(2)}, ${run.turns} turns`;
  if (run.job === "weekly" && run.outcome === "completed") {
    const report = newestReport(join(run.graphHome, "logs", "weekly-reports"), run.started);
    if (report) {
      const action = (report.text.match(/^- \[ \]/gm) ?? []).length;
      return {
        subject: `Weekly Graph Maintenance — ${date} (${action} action item${action === 1 ? "" : "s"})`,
        text: report.text + `\n\n---\nAPI runner, ${cost}. Report file: ${report.path}\n`,
      };
    }
    return alert(run, date, cost, "The weekly run finished but wrote no report this run.");
  }
  if (QUIET.has(run.outcome)) return null;
  return alert(run, date, cost);
}

function alert(run: RunSummaryForMail, date: string, cost: string, note?: string): Mail {
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
      `The ${run.job} run ${what[run.outcome] ?? `ended with outcome ${run.outcome}`} (${cost}).\n` +
      (note ? `${note}\n` : "") +
      `\nLog: ${run.logPath}\n\n${tail}\n`,
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
