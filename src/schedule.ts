export const WEEKLY_CRON = "0 8 * * 1";
export const WATCHDOG_CRON = "15 * * * *";

/** Last Monday 08:00 UTC at or before now; independent of any research dispatch record. */
export function expectedScheduledTime(now: number): number {
  const date = new Date(now);
  date.setUTCHours(8, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (date.getTime() > now) date.setUTCDate(date.getUTCDate() - 7);
  return date.getTime();
}
