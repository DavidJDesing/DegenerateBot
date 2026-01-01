import sqlite3 from "sqlite3";

sqlite3.verbose();

export function utcDayString(ms = Date.now()) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function openDb(file = "stats.sqlite") {
  const db = new sqlite3.Database(file);

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

  const exec = (sql) =>
    new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  return { db, run, get, all, exec };
}

export const DB = (() => {
  const { db, run, get, all, exec } = openDb("stats.sqlite");

  async function init() {
    await exec(`PRAGMA journal_mode = WAL;`);

    await exec(`
      CREATE TABLE IF NOT EXISTS user_daily (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        day      TEXT NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        voice_seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, day)
      );

      CREATE TABLE IF NOT EXISTS channel_daily (
        guild_id  TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        day       TEXT NOT NULL,
        messages  INTEGER NOT NULL DEFAULT 0,
        voice_seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, channel_id, day)
      );

      CREATE TABLE IF NOT EXISTS voice_sessions (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_daily_day
        ON user_daily (guild_id, user_id, day);

      CREATE INDEX IF NOT EXISTS idx_channel_daily_day
        ON channel_daily (guild_id, channel_id, day);
    `);
  }

  async function incUserMsg({ guild_id, user_id, day }) {
    await run(
      `
      INSERT INTO user_daily (guild_id, user_id, day, messages, voice_seconds)
      VALUES (?, ?, ?, 1, 0)
      ON CONFLICT (guild_id, user_id, day)
      DO UPDATE SET messages = messages + 1
      `,
      [guild_id, user_id, day]
    );
  }

  async function incChannelMsg({ guild_id, channel_id, day }) {
    await run(
      `
      INSERT INTO channel_daily (guild_id, channel_id, day, messages, voice_seconds)
      VALUES (?, ?, ?, 1, 0)
      ON CONFLICT (guild_id, channel_id, day)
      DO UPDATE SET messages = messages + 1
      `,
      [guild_id, channel_id, day]
    );
  }

  async function addUserVoice({ guild_id, user_id, day, voice_seconds }) {
    await run(
      `
      INSERT INTO user_daily (guild_id, user_id, day, messages, voice_seconds)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT (guild_id, user_id, day)
      DO UPDATE SET voice_seconds = voice_seconds + ?
      `,
      [guild_id, user_id, day, voice_seconds, voice_seconds]
    );
  }

  async function addChannelVoice({ guild_id, channel_id, day, voice_seconds }) {
    await run(
      `
      INSERT INTO channel_daily (guild_id, channel_id, day, messages, voice_seconds)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT (guild_id, channel_id, day)
      DO UPDATE SET voice_seconds = voice_seconds + ?
      `,
      [guild_id, channel_id, day, voice_seconds, voice_seconds]
    );
  }

  async function upsertSession({ guild_id, user_id, channel_id, started_at_ms }) {
    await run(
      `
      INSERT INTO voice_sessions (guild_id, user_id, channel_id, started_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET channel_id = excluded.channel_id,
                    started_at_ms = excluded.started_at_ms
      `,
      [guild_id, user_id, channel_id, started_at_ms]
    );
  }

  async function getSession(guild_id, user_id) {
    return await get(
      `
      SELECT guild_id, user_id, channel_id, started_at_ms
      FROM voice_sessions
      WHERE guild_id = ? AND user_id = ?
      `,
      [guild_id, user_id]
    );
  }

  async function deleteSession(guild_id, user_id) {
    await run(`DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?`, [
      guild_id,
      user_id,
    ]);
  }

  async function listSessionsForGuild(guild_id) {
    return await all(
      `
      SELECT guild_id, user_id, channel_id, started_at_ms
      FROM voice_sessions
      WHERE guild_id = ?
      `,
      [guild_id]
    );
  }

  async function sumUserRange(guild_id, user_id, startDay, endDay) {
    const row =
      (await get(
        `
        SELECT
          COALESCE(SUM(messages), 0) AS messages,
          COALESCE(SUM(voice_seconds), 0) AS voice_seconds
        FROM user_daily
        WHERE guild_id = ? AND user_id = ? AND day BETWEEN ? AND ?
        `,
        [guild_id, user_id, startDay, endDay]
      )) ?? { messages: 0, voice_seconds: 0 };

    return {
      messages: Number(row.messages ?? 0),
      voice_seconds: Number(row.voice_seconds ?? 0),
    };
  }

  async function sumChannelRange(guild_id, channel_id, startDay, endDay) {
    const row =
      (await get(
        `
        SELECT
          COALESCE(SUM(messages), 0) AS messages,
          COALESCE(SUM(voice_seconds), 0) AS voice_seconds
        FROM channel_daily
        WHERE guild_id = ? AND channel_id = ? AND day BETWEEN ? AND ?
        `,
        [guild_id, channel_id, startDay, endDay]
      )) ?? { messages: 0, voice_seconds: 0 };

    return {
      messages: Number(row.messages ?? 0),
      voice_seconds: Number(row.voice_seconds ?? 0),
    };
  }

  async function seriesUserRange(guild_id, user_id, startDay, endDay) {
    const rows = await all(
      `
      SELECT day, messages, voice_seconds
      FROM user_daily
      WHERE guild_id = ? AND user_id = ? AND day BETWEEN ? AND ?
      ORDER BY day ASC
      `,
      [guild_id, user_id, startDay, endDay]
    );

    return rows.map((r) => ({
      day: r.day,
      messages: Number(r.messages ?? 0),
      voice_seconds: Number(r.voice_seconds ?? 0),
    }));
  }

  async function seriesChannelRange(guild_id, channel_id, startDay, endDay) {
    const rows = await all(
      `
      SELECT day, messages, voice_seconds
      FROM channel_daily
      WHERE guild_id = ? AND channel_id = ? AND day BETWEEN ? AND ?
      ORDER BY day ASC
      `,
      [guild_id, channel_id, startDay, endDay]
    );

    return rows.map((r) => ({
      day: r.day,
      messages: Number(r.messages ?? 0),
      voice_seconds: Number(r.voice_seconds ?? 0),
    }));
  }

  return {
    db,
    init,

    utcDayString,

    incUserMsg,
    incChannelMsg,
    addUserVoice,
    addChannelVoice,

    upsertSession,
    getSession,
    deleteSession,
    listSessionsForGuild,

    sumUserRange,
    sumChannelRange,
    seriesUserRange,
    seriesChannelRange,
  };
})();
