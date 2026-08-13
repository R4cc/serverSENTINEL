/**
 * One cron implementation for both sides of the application. The panel evaluates schedules against
 * its own timezone, and the browser has to predict the same instants without sharing that timezone,
 * so parsing, validation, description, and next-run search all live here rather than being written
 * twice and drifting — which is exactly what happened to the two field validators this replaces.
 */

export type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
};

export type CronWallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const cronFieldRanges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const cronFieldLabels = ["minute", "hour", "day of month", "month", "weekday"];
const parsedCronCache = new Map<string, ParsedCron | null>();
const parsedCronCacheLimit = 500;

export function parseCronField(field: string, min: number, max: number) {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/", 2);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-", 2).map(Number);
        if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
        start = rawStart;
        end = rawEnd;
      } else {
        const exact = Number(rangePart);
        if (!Number.isInteger(exact)) return null;
        start = exact;
        end = exact;
      }
    }

    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

export function parseCron(cron: string) {
  const cached = parsedCronCache.get(cron);
  if (cached !== undefined) return cached;
  const fields = cronFields(cron);
  let parsed: ParsedCron | null = null;
  if (fields) {
    const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((field, index) =>
      parseCronField(field, cronFieldRanges[index][0], cronFieldRanges[index][1]));
    if (minutes && hours && daysOfMonth && months && daysOfWeek) {
      parsed = { minutes, hours, daysOfMonth, months, daysOfWeek };
    }
  }
  if (parsedCronCache.size >= parsedCronCacheLimit) parsedCronCache.clear();
  parsedCronCache.set(cron, parsed);
  return parsed;
}

/** The five fields, or null when the expression is not five fields long. */
export function cronFields(cron: string) {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 ? fields : null;
}

/**
 * The reason an expression is unusable, worded for a person reading it under a form field. Returns
 * null when the expression is valid, so it reads as "the error, if any".
 */
export function cronExpressionError(cron: string): string | null {
  const fields = cronFields(cron);
  if (!fields) return "Cron schedule must use five fields: minute hour day month weekday.";
  for (let index = 0; index < fields.length; index += 1) {
    const [min, max] = cronFieldRanges[index];
    if (!parseCronField(fields[index], min, max)) {
      return `Cron ${cronFieldLabels[index]} field is invalid. Use *, a number, a range, a list, or a step within ${min}-${max}.`;
    }
  }
  return null;
}

export function validateCron(cron: string) {
  const message = cronExpressionError(cron);
  if (message) {
    // The API has always reported these two cases separately; keep both wordings.
    throw new Error(cronFields(cron)
      ? "Cron schedule contains an invalid field"
      : "Cron schedule must use five fields: minute hour day month weekday");
  }
}

/** Sunday is both 0 and 7 in cron, and only the day-of-week field carries that duplication. */
function matchesWeekday(parsed: ParsedCron, weekday: number) {
  return parsed.daysOfWeek.has(weekday) || (weekday === 0 && parsed.daysOfWeek.has(7));
}

export function cronWallClockMatches(parsed: ParsedCron, wallClock: CronWallClock, weekday: number) {
  return parsed.minutes.has(wallClock.minute)
    && parsed.hours.has(wallClock.hour)
    && parsed.daysOfMonth.has(wallClock.day)
    && parsed.months.has(wallClock.month)
    && matchesWeekday(parsed, weekday);
}

function cronDateMatches(parsed: ParsedCron, date: Date) {
  return cronWallClockMatches(parsed, {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes()
  }, date.getDay());
}

/** Matches against the host's local time, which on the panel is the configured schedule timezone. */
export function cronMatches(cron: string, date: Date) {
  validateCron(cron);
  return cronDateMatches(parseCron(cron)!, date);
}

export function nextCronRun(cron: string, from = new Date(), maxDays = 366) {
  validateCron(cron);
  const parsed = parseCron(cron)!;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const maxChecks = Math.max(1, maxDays * 24 * 60);
  for (let checked = 0; checked < maxChecks; checked += 1) {
    if (cronDateMatches(parsed, cursor)) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string) {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function timeZoneWallClock(date: Date, timeZone: string): CronWallClock {
  const parts = wallClockFormatter(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute")
  };
}

export function timeZoneMinuteKey(date: Date, timeZone: string) {
  const wallClock = timeZoneWallClock(date, timeZone);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(wallClock.year, 4)}-${pad(wallClock.month)}-${pad(wallClock.day)}T${pad(wallClock.hour)}:${pad(wallClock.minute)}`;
}

/** Wall-clock fields as a UTC timestamp, which makes minute arithmetic free of DST discontinuities. */
function wallClockAsUtc(wallClock: CronWallClock) {
  return Date.UTC(wallClock.year, wallClock.month - 1, wallClock.day, wallClock.hour, wallClock.minute);
}

function timeZoneOffsetMs(instant: Date, timeZone: string) {
  return wallClockAsUtc(timeZoneWallClock(instant, timeZone)) - instant.getTime();
}

/**
 * The instant at which a timezone's clocks read the given wall time. The offset is sampled twice
 * because the first sample is taken at the wrong instant either side of a DST transition; a wall
 * time that a transition skips resolves to the instant the clocks jump to.
 */
export function zonedWallClockToInstant(wallClock: CronWallClock, timeZone: string) {
  const wallUtc = wallClockAsUtc(wallClock);
  const firstGuess = wallUtc - timeZoneOffsetMs(new Date(wallUtc), timeZone);
  const corrected = wallUtc - timeZoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(corrected);
}

/**
 * The next instants at which the expression fires for a panel running in `timeZone`. The search
 * walks wall-clock minutes, so it predicts what the panel's own local-time matching will do from a
 * browser in any other timezone.
 */
export function nextCronRunsInTimeZone(
  cron: string,
  timeZone: string,
  from: Date = new Date(),
  count = 3,
  maxDays = 366
): Date[] {
  const parsed = parseCron(cron);
  if (!parsed || count < 1) return [];
  const cursor = new Date(wallClockAsUtc(timeZoneWallClock(from, timeZone)) + 60_000);
  const matches: Date[] = [];
  const maxChecks = Math.max(1, maxDays * 24 * 60);
  for (let checked = 0; checked < maxChecks && matches.length < count; checked += 1) {
    const wallClock: CronWallClock = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      hour: cursor.getUTCHours(),
      minute: cursor.getUTCMinutes()
    };
    if (cronWallClockMatches(parsed, wallClock, cursor.getUTCDay())) {
      matches.push(zonedWallClockToInstant(wallClock, timeZone));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return matches;
}

/**
 * The shapes the schedule builder can express directly. Cron stays the stored format and the only
 * thing the API sees; these are a lossless reading of the handful of expressions people actually
 * write, with `advanced` carrying everything else unchanged.
 */
export type CronSchedulePlan =
  | { mode: "minutes"; every: number }
  | { mode: "hours"; every: number }
  | { mode: "daily"; hour: number; minute: number }
  | { mode: "weekly"; weekdays: number[]; hour: number; minute: number }
  | { mode: "advanced"; cron: string };

export type CronScheduleMode = CronSchedulePlan["mode"];

export function cronFromSchedulePlan(plan: CronSchedulePlan): string {
  if (plan.mode === "minutes") return `*/${plan.every} * * * *`;
  if (plan.mode === "hours") return `0 */${plan.every} * * *`;
  if (plan.mode === "daily") return `${plan.minute} ${plan.hour} * * *`;
  if (plan.mode === "weekly") {
    const weekdays = [...new Set(plan.weekdays)].sort((first, second) => first - second);
    return `${plan.minute} ${plan.hour} * * ${weekdays.length ? weekdays.join(",") : "*"}`;
  }
  return plan.cron;
}

/**
 * Reads an expression back into the builder. Anything outside the four simple shapes comes back as
 * `advanced` rather than being approximated, so opening a schedule for editing can never quietly
 * rewrite an expression its author tuned by hand.
 */
export function schedulePlanFromCron(cron: string): CronSchedulePlan {
  const fields = cronFields(cron);
  const advanced: CronSchedulePlan = { mode: "advanced", cron };
  if (!fields || cronExpressionError(cron)) return advanced;
  const [minute, hour, day, month, weekday] = fields;
  if (day !== "*" || month !== "*") return advanced;

  const minuteStep = stepValue(minute);
  if (minuteStep !== null && hour === "*" && weekday === "*") return { mode: "minutes", every: minuteStep };
  const hourStep = stepValue(hour);
  if (minute === "0" && hourStep !== null && weekday === "*") return { mode: "hours", every: hourStep };

  const exactMinute = exactNumber(minute);
  const exactHour = exactNumber(hour);
  if (exactMinute === null || exactHour === null) return advanced;
  if (weekday === "*") return { mode: "daily", hour: exactHour, minute: exactMinute };

  const weekdays = expandSimpleValues(weekday);
  if (!weekdays?.length) return advanced;
  // Cron accepts 7 for Sunday; the builder offers one Sunday checkbox.
  const normalized = [...new Set(weekdays.map((value) => value === 7 ? 0 : value))].sort((first, second) => first - second);
  return { mode: "weekly", weekdays: normalized, hour: exactHour, minute: exactMinute };
}

function stepValue(field: string) {
  if (!field.startsWith("*/")) return null;
  const step = Number(field.slice(2));
  return Number.isInteger(step) && step > 0 ? step : null;
}

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function describeCronExpression(cron: string): string | null {
  const fields = cronFields(cron);
  if (!fields || cronExpressionError(cron)) return null;
  const [minute, hour, day, month, weekday] = fields;
  const exactTime = exactNumber(minute) !== null && exactNumber(hour) !== null
    ? `${pad(hour)}:${pad(minute)}`
    : null;

  if (minute.startsWith("*/") && hour === "*" && day === "*" && month === "*" && weekday === "*") {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (minute === "0" && hour.startsWith("*/") && day === "*" && month === "*" && weekday === "*") {
    return `Every ${hour.slice(2)} hours`;
  }
  if (exactTime && day === "*" && month === "*" && weekday === "*") return `Daily at ${exactTime}`;
  if (exactTime && day === "*" && month === "*" && weekday !== "*") {
    return `${formatWeekdays(weekday)} at ${exactTime}`;
  }
  if (exactTime && exactNumber(day) !== null && month === "*" && weekday === "*") {
    return `On day ${day} of every month at ${exactTime}`;
  }
  if (exactTime && exactNumber(day) !== null && exactNumber(month) !== null && weekday === "*") {
    return `Every ${monthNames[Number(month)]} ${ordinal(Number(day))} at ${exactTime}`;
  }

  return `Runs when ${describeField("minute", minute)}, ${describeField("hour", hour)}, ${describeField("day", day)}, ${describeField("month", month)}, and ${describeField("weekday", weekday)}.`;
}

function exactNumber(value: string) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function pad(value: string) {
  return value.padStart(2, "0");
}

function formatWeekdays(value: string) {
  const values = expandSimpleValues(value);
  if (!values) return `On weekday ${value}`;
  const names = [...new Set(values.map((day) => weekdayNames[day]))];
  if (names.length === 1) return `Every ${names[0]}`;
  if (names.length === 5 && names.join(",") === "Monday,Tuesday,Wednesday,Thursday,Friday") return "Every weekday";
  return `Every ${joinWords(names)}`;
}

function expandSimpleValues(value: string) {
  const result: number[] = [];
  for (const part of value.split(",")) {
    if (/^\d+$/.test(part)) {
      result.push(Number(part));
      continue;
    }
    const match = /^(\d+)-(\d+)$/.exec(part);
    if (!match) return null;
    for (let current = Number(match[1]); current <= Number(match[2]); current += 1) result.push(current);
  }
  return result.every((item) => item >= 0 && item <= 7) ? result : null;
}

function joinWords(values: string[]) {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function ordinal(value: number) {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}

function describeField(label: string, value: string) {
  if (value === "*") return `${label} is any value`;
  if (value.startsWith("*/")) return `${label} is every ${value.slice(2)}`;
  return `${label} matches ${value}`;
}
