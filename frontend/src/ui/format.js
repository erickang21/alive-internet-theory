const YEAR_DAYS = 365;
const MONTH_DAYS = 30;

/** One decimal at most, and never a trailing ".0". */
export function number(value, suffix = "") {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}${suffix}` : null;
}

export function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

export function count(value, singular, plural = `${singular}s`) {
  if (!Number.isFinite(value)) return null;
  return `${value} ${value === 1 ? singular : plural}`;
}

/** Days become months and then years, so nothing is ever quoted as "981 days". */
export function days(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= YEAR_DAYS) return plural(value / YEAR_DAYS, "year");
  if (value >= MONTH_DAYS) return plural(value / MONTH_DAYS, "month");
  return plural(value, "day");
}

/** The same scale from the other end, for gaps measured in hours. */
export function hours(value) {
  if (!Number.isFinite(value)) return null;
  return value >= 48 ? days(value / 24) : plural(value, "hour");
}

function plural(value, unit) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? unit : `${unit}s`}`;
}
