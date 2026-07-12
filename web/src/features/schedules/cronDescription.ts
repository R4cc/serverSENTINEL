import { validateCronExpression } from "../../utils/validation";

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function describeCronExpression(cron: string): string | null {
  if (validateCronExpression(cron)) return null;
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
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
  const values = expandSimpleValues(value, 0, 7);
  if (!values) return `On weekday ${value}`;
  const names = [...new Set(values.map((day) => weekdayNames[day]))];
  if (names.length === 1) return `Every ${names[0]}`;
  if (names.length === 5 && names.join(",") === "Monday,Tuesday,Wednesday,Thursday,Friday") return "Every weekday";
  return `Every ${joinWords(names)}`;
}

function expandSimpleValues(value: string, min: number, max: number) {
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
  return result.every((item) => item >= min && item <= max) ? result : null;
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
