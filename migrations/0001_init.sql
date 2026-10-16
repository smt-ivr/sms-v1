-- ============================================================
--  S.M.T Messages V2 — initial schema
--  כל הטבלאות מתחילות ב-v2_ כדי לא להתנגש בטבלאות של הגרסה הישנה
--  (access_codes, system_tokens, temp_codes, access_logs, settings ...)
-- ============================================================

-- ---------- משתמשים ----------
CREATE TABLE IF NOT EXISTS v2_users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL,
  email_canonical  TEXT NOT NULL UNIQUE,          -- gmail: בלי נקודות ו-+tag, הכל lowercase
  name             TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user',  -- user | admin | owner
  status           TEXT NOT NULL DEFAULT 'active',-- active | pending | blocked
  block_reason     TEXT,
  plan             TEXT NOT NULL DEFAULT 'free',
  max_systems      INTEGER,                        -- NULL = לפי החבילה
  daily_sms_limit  INTEGER,                        -- NULL = לפי החבילה
  admin_notes      TEXT,
  signup_ip        TEXT,
  last_login_at    INTEGER,
  last_ip          TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_users_status ON v2_users(status);

-- ---------- קודי אימות במייל (הרשמה / איפוס סיסמה) ----------
CREATE TABLE IF NOT EXISTS v2_email_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_canonical TEXT NOT NULL,
  purpose     TEXT NOT NULL,                       -- register | reset
  code_hash   TEXT NOT NULL,
  payload     TEXT,                                -- JSON (שם, hash סיסמה) להרשמה
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_email_codes ON v2_email_codes(email_canonical, purpose);

-- ---------- סשנים (משתמשים + אורחים) ----------
CREATE TABLE IF NOT EXISTS v2_sessions (
  id              TEXT PRIMARY KEY,                -- sha256 של הטוקן שבעוגייה
  kind            TEXT NOT NULL DEFAULT 'user',    -- user | guest
  user_id         INTEGER,
  share_id        INTEGER,
  impersonator_id INTEGER,
  ip              TEXT,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_sessions_user ON v2_sessions(user_id);

-- ---------- הגבלת קצב ----------
CREATE TABLE IF NOT EXISTS v2_rate (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- ---------- הגדרות מערכת (נפרד מ-settings הישנה) ----------
CREATE TABLE IF NOT EXISTS v2_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- חבילות ----------
CREATE TABLE IF NOT EXISTS v2_plans (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  max_systems     INTEGER NOT NULL DEFAULT 1,
  daily_sms_limit INTEGER,                          -- NULL = ללא הגבלה
  features        TEXT NOT NULL DEFAULT '{}',       -- {"messages.bulk":1,...}
  sort            INTEGER NOT NULL DEFAULT 0
);

-- ---------- פיצ'רים (מתגים גלובליים) ----------
CREATE TABLE IF NOT EXISTS v2_features (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  description    TEXT,
  global_enabled INTEGER NOT NULL DEFAULT 1,        -- מתג חירום: 0 = כבוי לכולם
  default_value  INTEGER NOT NULL DEFAULT 1,        -- ברירת מחדל למי שאין לו דריסה/חבילה
  new_user_value INTEGER,                           -- ערך שנכתב כדריסה לחשבונות חדשים (NULL = לא לגעת)
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS v2_user_features (
  user_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ---------- מערכות ימות המשיח ----------
CREATE TABLE IF NOT EXISTS v2_systems (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  number        TEXT,                               -- מספר מערכת (username)
  auth_type     TEXT NOT NULL,                      -- token | password
  secret_enc    TEXT,                               -- סיסמה מוצפנת AES-GCM (כשמחוברים בסיסמה)
  token_enc     TEXT NOT NULL,                      -- הטוקן הנוכחי, מוצפן. לעולם לא נשלח לדפדפן
  sender        TEXT,                               -- שם/מספר שולח ברירת מחדל
  color         TEXT,
  status        TEXT NOT NULL DEFAULT 'ok',         -- ok | mfa | error
  status_msg    TEXT,
  last_check_at INTEGER,
  legacy_id     INTEGER,                            -- מזהה system_tokens בגרסה הישנה (אם יובא)
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_systems_user ON v2_systems(user_id);

-- ---------- אנשי קשר וקבוצות ----------
CREATE TABLE IF NOT EXISTS v2_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  phone       TEXT NOT NULL,
  name        TEXT,
  email       TEXT,
  notes       TEXT,
  is_blocked  INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, phone)
);

CREATE TABLE IF NOT EXISTS v2_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_group_members (
  group_id   INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, contact_id)
);

-- ---------- מצב שיחות (נקרא/מוצמד/בארכיון) ----------
CREATE TABLE IF NOT EXISTS v2_conv_meta (
  user_id      INTEGER NOT NULL,
  system_id    INTEGER NOT NULL,
  phone        TEXT NOT NULL,
  last_read    TEXT,                                -- תאריך ההודעה האחרונה שנקראה (פורמט ימות)
  pinned       INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, system_id, phone)
);

-- ---------- תבניות ----------
CREATE TABLE IF NOT EXISTS v2_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------- הודעות מתוזמנות ----------
CREATE TABLE IF NOT EXISTS v2_scheduled (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  system_id   INTEGER NOT NULL,
  batch_id    TEXT NOT NULL,                        -- קמפיין: כל השורות של אותה שליחה
  label       TEXT,
  via         TEXT NOT NULL DEFAULT 'bulk',
  phones      TEXT NOT NULL,                        -- JSON array
  body        TEXT NOT NULL,
  send_at     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',      -- pending | sent | failed | canceled
  result      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_scheduled_due ON v2_scheduled(status, send_at);
CREATE INDEX IF NOT EXISTS idx_v2_scheduled_batch ON v2_scheduled(user_id, batch_id);

-- ---------- יומן שליחות (מכסות + סטטיסטיקה) ----------
CREATE TABLE IF NOT EXISTS v2_send_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  system_id   INTEGER,
  via         TEXT NOT NULL,                        -- app | bulk | schedule | api | guest | autoreply
  recipients  INTEGER NOT NULL,
  preview     TEXT,
  ok          INTEGER NOT NULL,
  error       TEXT,
  actor       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_send_log_user ON v2_send_log(user_id, created_at);

-- ---------- אוטומציות: SMS למייל / מענה אוטומטי / Webhook ----------
CREATE TABLE IF NOT EXISTS v2_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  system_id      INTEGER NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,                     -- email | autoreply | webhook
  enabled        INTEGER NOT NULL DEFAULT 1,
  days           TEXT NOT NULL DEFAULT '0123456',   -- 0=ראשון ... 6=שבת
  start_min      INTEGER NOT NULL DEFAULT 0,        -- דקות מחצות (שעון ישראל)
  end_min        INTEGER NOT NULL DEFAULT 1440,
  outside_mode   TEXT NOT NULL DEFAULT 'hold',      -- hold = לשמור לחלון הבא | skip = לדלג
  mode           TEXT NOT NULL DEFAULT 'instant',   -- instant | digest
  digest_minutes INTEGER NOT NULL DEFAULT 60,
  filter_keyword TEXT,
  filter_sender  TEXT,
  target         TEXT NOT NULL,                     -- מייל / כתובת webhook / טקסט מענה
  secret         TEXT,                              -- חתימת webhook
  cooldown_hours INTEGER NOT NULL DEFAULT 12,       -- למענה אוטומטי
  cursor         TEXT,                              -- תאריך ההודעה האחרונה שטופלה
  cursor_keys    TEXT,
  last_run_at    INTEGER,
  last_fire_at   INTEGER,
  fire_count     INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_autoreply_log (
  rule_id    INTEGER NOT NULL,
  phone      TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (rule_id, phone)
);

-- ---------- קישורי גישה לאורחים (יורש של "קודים זמניים") ----------
CREATE TABLE IF NOT EXISTS v2_shares (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  system_id    INTEGER NOT NULL,
  label        TEXT NOT NULL,
  code_hash    TEXT NOT NULL UNIQUE,
  code_hint    TEXT,
  can_read     INTEGER NOT NULL DEFAULT 1,
  can_send     INTEGER NOT NULL DEFAULT 0,
  phones       TEXT,                                -- רשימת מספרים מותרים (JSON) או NULL = הכל
  max_sends    INTEGER,
  sends        INTEGER NOT NULL DEFAULT 0,
  uses         INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  expires_at   INTEGER,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- ---------- מפתחות API ----------
CREATE TABLE IF NOT EXISTS v2_api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- ---------- תמיכה: צ'אט עם המנהל ----------
CREATE TABLE IF NOT EXISTS v2_support_threads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',        -- open | closed
  user_unread  INTEGER NOT NULL DEFAULT 0,
  admin_unread INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_support_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL,
  sender_role TEXT NOT NULL,                        -- user | admin
  sender_id   INTEGER,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_support_messages ON v2_support_messages(thread_id);

-- ---------- התראות ----------
CREATE TABLE IF NOT EXISTS v2_notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_notifications_user ON v2_notifications(user_id, is_read);

-- ---------- הודעות מערכת (באנר) ----------
CREATE TABLE IF NOT EXISTS v2_announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT,
  level      TEXT NOT NULL DEFAULT 'info',          -- info | warn | success
  active     INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- ---------- יומן ביקורת ----------
CREATE TABLE IF NOT EXISTS v2_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,                               -- על מי הפעולה
  actor_id   INTEGER,                               -- מי ביצע
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_audit_created ON v2_audit(created_at);

-- ============================================================
--  נתוני התחלה
-- ============================================================
INSERT OR IGNORE INTO v2_settings (key, value) VALUES
  ('app_name', 'S.M.T Messages'),
  ('registration_mode', 'open'),          -- open | approval | closed
  ('default_plan', 'free'),
  ('maintenance', '0'),
  ('maintenance_message', 'המערכת בתחזוקה קצרה. נחזור בקרוב.'),
  ('signups_per_ip_per_day', '3'),
  ('block_disposable_emails', '1'),
  ('login_alerts', '1'),
  ('rules_poll_minutes', '2'),
  ('support_enabled', '1');

INSERT OR IGNORE INTO v2_plans (key, name, description, max_systems, daily_sms_limit, features, sort) VALUES
  ('free', 'חינם', 'מערכת אחת, שליחה רגילה ואנשי קשר', 1, 50,
   '{"messages.bulk":0,"messages.schedule":0,"rules.autoreply":0,"rules.webhook":0,"api":0,"shares":0}', 1),
  ('pro', 'מקצועי', 'עד 5 מערכות, שליחה קבוצתית, תזמון ואוטומציות', 5, 1000, '{}', 2),
  ('business', 'עסקי', 'ללא הגבלת הודעות, API ושיתוף גישה', 25, NULL, '{}', 3);

INSERT OR IGNORE INTO v2_features (key, label, description, sort) VALUES
  ('messages.send',     'שליחת הודעות',        'שליחת SMS מתוך תיבת ההודעות', 1),
  ('messages.bulk',     'שליחה קבוצתית',       'שליחה לקבוצות ולרשימות, כולל התאמה אישית', 2),
  ('messages.schedule', 'תזמון הודעות',        'קביעת שליחה לתאריך ושעה', 3),
  ('messages.export',   'ייצוא שיחות',         'הורדת שיחות כקובץ CSV', 4),
  ('contacts',          'אנשי קשר',            'ניהול אנשי קשר וקבוצות', 5),
  ('contacts.import',   'ייבוא אנשי קשר',      'ייבוא וייצוא CSV', 6),
  ('templates',         'תבניות',              'שמירת נוסחי הודעות קבועים', 7),
  ('rules.email',       'SMS למייל',           'העברת הודעות נכנסות למייל לפי שעות', 8),
  ('rules.autoreply',   'מענה אוטומטי',        'תשובה אוטומטית להודעות נכנסות', 9),
  ('rules.webhook',     'Webhook',             'שליחת הודעות נכנסות לכתובת חיצונית', 10),
  ('shares',            'גישת אורחים',         'קודי גישה מוגבלים לאנשים אחרים', 11),
  ('api',               'API למפתחים',         'מפתחות API לשליחה מתוך מערכות אחרות', 12),
  ('systems.add',       'הוספת מערכות',        'חיבור מערכות חדשות לחשבון', 13),
  ('support',           'צ׳אט תמיכה',          'פתיחת פניות למנהל המערכת', 14),
  ('legacy.import',     'ייבוא מהגרסה הישנה', 'משיכת מערכות מהקוד האישי הישן', 15);
