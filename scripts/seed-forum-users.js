require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const LEAGUE_ID = process.env.LEAGUE_ID;
const SLEEPER_BASE_URL = process.env.SLEEPER_BASE_URL || "https://api.sleeper.app/v1";
const REPORT_PATH = path.join(__dirname, "..", "data", "forum-seed-report.json");

if (!LEAGUE_ID) {
  console.error("LEAGUE_ID is required in .env");
  process.exit(1);
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "domination_league",
  user: process.env.POSTGRES_USER || "domination_app",
  password: process.env.POSTGRES_PASSWORD || "domination_pass"
});

async function fetchSleeperJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Sleeper request failed: ${response.status}`);
  }
  return response.json();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function getPreferredLoginName(user) {
  const username = normalizeUsername(user.username);
  if (username) {
    return username;
  }

  // Some historical leagues return empty "username"; display_name is still user-level identity.
  return normalizeUsername(user.display_name);
}

async function main() {
  const [users] = await Promise.all([
    fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/users`)
  ]);

  const passwordHash = await bcrypt.hash("password123", 10);

  const client = await pool.connect();
  const report = {
    leagueId: LEAGUE_ID,
    seededAt: new Date().toISOString(),
    users: [],
    skipped: []
  };

  try {
    await client.query("BEGIN");

    for (const user of users) {
      const username = getPreferredLoginName(user);
      if (!username) {
        report.skipped.push({
          sleeperUserId: user.user_id || null,
          reason: "No username or display_name"
        });
        continue;
      }

      const result = await client.query(
        `
          INSERT INTO forum_users (sleeper_user_id, username, password_hash, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (username)
          DO UPDATE SET
            sleeper_user_id = EXCLUDED.sleeper_user_id,
            password_hash = EXCLUDED.password_hash,
            updated_at = NOW()
          RETURNING id, username, sleeper_user_id;
        `,
        [user.user_id || null, username, passwordHash]
      );

      report.users.push(result.rows[0]);
    }

    await client.query("COMMIT");

    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(`Seeded ${report.users.length} forum users from league ${LEAGUE_ID}.`);
    console.log("All account passwords set to: password123");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("User seeding failed:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
