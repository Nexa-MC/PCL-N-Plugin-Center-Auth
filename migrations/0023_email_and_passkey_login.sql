-- Short-lived sign-in challenges and minimal automatic mail receipt records.
CREATE INDEX users_login_email ON users(lower(email)) WHERE disabled=0 AND confirmed_at IS NOT NULL;
CREATE TABLE email_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  code_mac TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_login_expiry ON email_login_challenges(expires);
CREATE TABLE passkey_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkey_login_expiry ON passkey_login_challenges(expires);
CREATE TABLE mail_auto_replies (
  email_id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  sender_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent')),
  reply_id TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX mail_reply_sender ON mail_auto_replies(sender_hash,mailbox,created_at);
CREATE TABLE mail_send_reservations (
  id TEXT PRIMARY KEY,
  sender_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX mail_send_sender ON mail_send_reservations(sender_hash,created_at);
CREATE INDEX mail_send_created ON mail_send_reservations(created_at);
CREATE TABLE mail_inbox_state (
  account_hash TEXT PRIMARY KEY,
  uid_validity TEXT,
  last_uid INTEGER,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
