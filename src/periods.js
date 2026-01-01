function utcDayStringFromDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addUtcDays(yyyyMMdd, deltaDays) {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return utcDayStringFromDate(dt);
}

export function resolveRange({ period, from, to }) {
  const today = utcDayStringFromDate(new Date());

  if (from && to) {
    return { start: from, end: to, label: `${from} → ${to}` };
  }

  const p = (period ?? "30d").toLowerCase();

  if (p === "all") {
    return { start: "1970-01-01", end: today, label: "All time" };
  }

  const match = p.match(/^(\d+)\s*d$/);
  const days = match ? Number(match[1]) : 30;

  const start = addUtcDays(today, -(days - 1));
  return { start, end: today, label: `Last ${days} days` };
}

export function ensureSeriesDays(series, start, end) {
  const map = new Map(series.map((r) => [r.day, r]));
  const out = [];

  let cursor = start;
  while (cursor <= end) {
    const r = map.get(cursor) ?? { day: cursor, messages: 0, voice_seconds: 0 };
    out.push({
      day: r.day,
      messages: Number(r.messages ?? 0),
      voice_seconds: Number(r.voice_seconds ?? 0),
    });
    cursor = addUtcDays(cursor, 1);
  }

  return out;
}

export function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

export function formatHours(totalSeconds) {
  const hours = totalSeconds / 3600;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(0)}h`;
}
