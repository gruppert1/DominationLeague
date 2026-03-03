require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "domination_league",
  user: process.env.POSTGRES_USER || "domination_app",
  password: process.env.POSTGRES_PASSWORD || "domination_pass"
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_users (
        id SERIAL PRIMARY KEY,
        sleeper_user_id TEXT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES forum_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_posts (
        id SERIAL PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('announcements', 'weekly-reports')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author_user_id INTEGER NOT NULL REFERENCES forum_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        author_user_id INTEGER NOT NULL REFERENCES forum_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forum_posts_channel_created_at
      ON forum_posts(channel, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forum_comments_post_created_at
      ON forum_comments(post_id, created_at ASC);
    `);

    await client.query("COMMIT");
    console.log("Forum database schema initialized.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DB init failed:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
