// Pure helpers for the Scheduled and Subagents sections: plain-English
// schedules and subagent status rollups. No I/O.
import type { Subagent } from "./types.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${twelve}${suffix}` : `${twelve}:${String(minute).padStart(2, "0")}${suffix}`;
}

/**
 * A short description of a five-field cron expression. Common shapes read
 * as English ("Every 10 minutes", "Weekdays at 9am"); anything else falls
 * back to the expression itself.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return expression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const everyDay = dayOfMonth === "*" && month === "*";
  const step = (field: string) => /^\*\/(\d+)$/u.exec(field)?.[1];
  const number = (field: string) => (/^\d+$/u.test(field) ? Number(field) : null);

  if (everyDay && dayOfWeek === "*") {
    if (minute === "*" && hour === "*") return "Every minute";
    const minuteStep = step(minute);
    if (minuteStep !== undefined && hour === "*") return `Every ${minuteStep} minutes`;
    const hourStep = step(hour);
    if (number(minute) !== null && hour === "*") return `Hourly at :${String(number(minute)).padStart(2, "0")}`;
    if (number(minute) === 0 && hourStep !== undefined) return `Every ${hourStep} hours`;
  }
  const h = number(hour);
  const m = number(minute);
  if (everyDay && h !== null && m !== null) {
    if (dayOfWeek === "*") return `Daily at ${clock(h, m)}`;
    if (dayOfWeek === "1-5") return `Weekdays at ${clock(h, m)}`;
    const day = number(dayOfWeek);
    if (day !== null && day >= 0 && day <= 7) return `${DAYS[day % 7]}s at ${clock(h, m)}`;
  }
  return expression;
}

/** "2 running · 3 done", in the order that needs attention first. */
export function summarizeSubagents(subagents: readonly Pick<Subagent, "status">[]): string {
  const order: Subagent["status"][] = ["failed", "running", "pending", "done", "stopped"];
  const words: Record<Subagent["status"], string> = {
    failed: "failed",
    running: "running",
    pending: "waiting",
    done: "done",
    stopped: "stopped",
  };
  return order
    .map((status) => [status, subagents.filter((subagent) => subagent.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${words[status]}`)
    .join(" · ");
}
