export const databaseSchema = `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
  context_json TEXT, confirmed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(token_hash),
  operation_key TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(session_id, operation_key)
);
CREATE TABLE IF NOT EXISTS onboarding_chats (
  session_id TEXT PRIMARY KEY REFERENCES sessions(token_hash), state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_connections (
  session_id TEXT PRIMARY KEY REFERENCES sessions(token_hash),
  revision INTEGER NOT NULL, connection_json TEXT
);
CREATE TABLE IF NOT EXISTS calendar_oauth_states (
  state_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(token_hash),
  encrypted_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
  base_revision INTEGER NOT NULL, browser_token_hash TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  email_verified_at TEXT, profile_id TEXT UNIQUE NOT NULL REFERENCES sessions(token_hash),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_limits (
  key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS network_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id), settings_json TEXT NOT NULL, qr_token TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS network_connections (
  user_a TEXT NOT NULL REFERENCES users(id), user_b TEXT NOT NULL REFERENCES users(id),
  requester_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, context TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(user_a, user_b), CHECK(user_a < user_b)
);
CREATE TABLE IF NOT EXISTS network_blocks (
  user_id TEXT NOT NULL REFERENCES users(id), blocked_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, PRIMARY KEY(user_id, blocked_user_id), CHECK(user_id != blocked_user_id)
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL, message_json TEXT NOT NULL, answers_json TEXT NOT NULL DEFAULT '{}',
  answer_revision INTEGER, created_at TEXT NOT NULL, UNIQUE(from_user_id, request_key)
);
CREATE INDEX IF NOT EXISTS agent_messages_recipient ON agent_messages(to_user_id, created_at);
CREATE TABLE IF NOT EXISTS network_jobs (
  user_id TEXT PRIMARY KEY REFERENCES users(id), version INTEGER NOT NULL,
  updated_at TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS network_events (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), event_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS network_events_owner ON network_events(user_id);
CREATE TABLE IF NOT EXISTS network_opportunities (
  id TEXT PRIMARY KEY, user_a TEXT NOT NULL REFERENCES users(id), user_b TEXT NOT NULL REFERENCES users(id),
  signature TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  dismissed_a INTEGER NOT NULL DEFAULT 0, dismissed_b INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_a, user_b), CHECK(user_a < user_b)
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, initiator_id TEXT NOT NULL REFERENCES users(id),
  first_user_id TEXT NOT NULL REFERENCES users(id), second_user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
  UNIQUE(initiator_id, request_id)
);
CREATE INDEX IF NOT EXISTS meetings_first ON meetings(first_user_id);
CREATE INDEX IF NOT EXISTS meetings_second ON meetings(second_user_id);
CREATE TABLE IF NOT EXISTS database_leases (
  key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Migrations are additive so existing local accounts and calendar grants survive.
export const additiveColumns = [
  { table: "calendar_oauth_states", name: "browser_token_hash", sql: "TEXT" },
  {
    table: "network_connections",
    name: "revision",
    sql: "INTEGER NOT NULL DEFAULT 1",
  },
  { table: "network_jobs", name: "cursor", sql: "TEXT NOT NULL DEFAULT ''" },
] as const;
