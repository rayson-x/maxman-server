export const MINIMUM_USER_AGE = 18;

function calendarParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/**
 * birthDate is stored as UTC midnight for a date-only API value; asOf is
 * interpreted in the explicit policy timezone, never in the server/UTC locale.
 */
export function isAtLeast18(
  birthDate: Date,
  asOf: Date = new Date(),
  policyTimeZone = process.env.AGE_POLICY_TIMEZONE ?? "Asia/Shanghai",
): boolean {
  if (Number.isNaN(birthDate.getTime()) || birthDate.getTime() > asOf.getTime()) return false;

  const birth = {
    year: birthDate.getUTCFullYear(),
    month: birthDate.getUTCMonth() + 1,
    day: birthDate.getUTCDate(),
  };
  const current = calendarParts(asOf, policyTimeZone);
  let age = current.year - birth.year;
  const birthdayHasPassed =
    current.month > birth.month ||
    (current.month === birth.month && current.day >= birth.day);
  if (!birthdayHasPassed) age -= 1;
  return age >= MINIMUM_USER_AGE;
}

/**
 * 自声明必须为 true；若用户同时提交了出生日期，日期也必须证明已满 18 岁。
 * birthDate 仍兼容首版已有的可选采集契约，不能用缺失日期覆盖显式的 true 声明。
 */
export function isAdultEligible(
  user: { ageConfirmed18Plus: boolean; birthDate: Date | null },
  asOf: Date = new Date(),
): boolean {
  return (
    user.ageConfirmed18Plus === true &&
    (user.birthDate === null || isAtLeast18(user.birthDate, asOf))
  );
}
