export const SCHEMA_VERSION = 1;

// Every tenant-scoped table carries workspace_id; all queries filter on it.
export const SCHEMA_SQL = /* sql */ `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'personal', timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  settings TEXT NOT NULL DEFAULT '{}', is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','reviewer','viewer')),
  can_publish_external INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, audience TEXT, positioning TEXT, voice_summary TEXT,
  tone TEXT, language TEXT NOT NULL DEFAULT 'ja', preferred_terms TEXT NOT NULL DEFAULT '[]',
  banned_terms TEXT NOT NULL DEFAULT '[]', cta_style TEXT, banned_ctas TEXT NOT NULL DEFAULT '[]',
  emoji_policy TEXT NOT NULL DEFAULT 'few', max_emoji INTEGER NOT NULL DEFAULT 2,
  sentence_style TEXT, hashtags_policy TEXT, examples_good TEXT NOT NULL DEFAULT '[]',
  examples_bad TEXT NOT NULL DEFAULT '[]', voice_status TEXT NOT NULL DEFAULT 'unset',
  voice_draft TEXT, ai_eligible INTEGER NOT NULL DEFAULT 1, locale_profiles TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, url TEXT, file_ref TEXT, text TEXT,
  duration_sec INTEGER, author TEXT, published_at TEXT, imported_at TEXT NOT NULL, language TEXT,
  rights_status TEXT NOT NULL DEFAULT 'unknown', rights_note TEXT, attribution TEXT,
  status TEXT NOT NULL DEFAULT 'imported', content_hash TEXT, ai_eligible INTEGER NOT NULL DEFAULT 1,
  evergreen INTEGER NOT NULL DEFAULT 0, evergreen_category TEXT,
  analysis TEXT, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_ws ON sources(workspace_id, imported_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash ON sources(workspace_id, content_hash) WHERE deleted_at IS NULL AND content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL,
  confidence REAL, inaudible INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_seg_source ON transcript_segments(source_id, idx);

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, brand_id TEXT, name TEXT NOT NULL, theme TEXT,
  cadence TEXT, format TEXT, idea_pool TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT, core_idea TEXT NOT NULL, angle TEXT, topic TEXT, source_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new', first_used_at TEXT, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL, embedding_ref TEXT, evergreen INTEGER NOT NULL DEFAULT 0, evergreen_category TEXT,
  series_id TEXT, origin TEXT NOT NULL DEFAULT 'source', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_ws ON ideas(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_ideas_topic ON ideas(workspace_id, topic);

CREATE TABLE IF NOT EXISTS idea_uses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  content_id TEXT, platform TEXT NOT NULL, used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uses_idea ON idea_uses(idea_id, used_at);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
  model TEXT NOT NULL, vector TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_ref ON embeddings(workspace_id, ref_type, ref_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT, name TEXT NOT NULL, objective TEXT, start_date TEXT, end_date TEXT, product TEXT,
  audience TEXT, key_messages TEXT NOT NULL DEFAULT '[]', source_ids TEXT NOT NULL DEFAULT '[]',
  channels TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'planning', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_steps (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, ord INTEGER NOT NULL, planned_date TEXT, platform TEXT, content_id TEXT, key_message TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, brand_id TEXT, objective TEXT, audience TEXT, message TEXT,
  cta TEXT, platform TEXT, source_ids TEXT NOT NULL DEFAULT '[]', constraints TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_packs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_ids TEXT NOT NULL, brand_id TEXT, campaign_id TEXT, brief_id TEXT, generation_config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', generator TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pack_id TEXT, idea_id TEXT, source_ids TEXT NOT NULL DEFAULT '[]', platform TEXT NOT NULL, format TEXT NOT NULL,
  title TEXT, body TEXT NOT NULL, structured TEXT, media_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft', brand_id TEXT, campaign_id TEXT, series_id TEXT,
  scheduled_at TEXT, published_at TEXT, published_via TEXT, external_post_id TEXT, external_url TEXT,
  created_by TEXT, reviewed_by TEXT, human_edited INTEGER NOT NULL DEFAULT 0, ai_suggestion TEXT,
  version INTEGER NOT NULL DEFAULT 1, approved_version INTEGER, recycle_state TEXT, locale TEXT,
  parent_content_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_ws ON content_items(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_content_idea ON content_items(idea_id);
CREATE INDEX IF NOT EXISTS idx_content_sched ON content_items(workspace_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_content_when ON content_items(workspace_id, COALESCE(scheduled_at, published_at));
CREATE INDEX IF NOT EXISTS idx_content_pub ON content_items(workspace_id, status, published_at);
CREATE INDEX IF NOT EXISTS idx_content_status_plat ON content_items(workspace_id, status, platform, scheduled_at);

CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, title TEXT, body TEXT NOT NULL, author_type TEXT NOT NULL, author_id TEXT,
  note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL, actor_id TEXT, version INTEGER, comment TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  user_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, adapter TEXT NOT NULL, account_label TEXT, status TEXT NOT NULL DEFAULT 'disconnected',
  token_enc TEXT, refresh_enc TEXT, token_expires_at TEXT, scopes TEXT NOT NULL DEFAULT '[]',
  health TEXT, last_checked_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE, platform TEXT NOT NULL,
  connector_id TEXT, mode TEXT NOT NULL, scheduled_at TEXT NOT NULL, timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE,
  external_id TEXT, last_error TEXT, next_attempt_at TEXT, content_version INTEGER,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON publish_jobs(status, scheduled_at);

CREATE TABLE IF NOT EXISTS performance_snapshots (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL, platform TEXT NOT NULL, captured_at TEXT NOT NULL, window TEXT NOT NULL,
  metrics TEXT NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_content ON performance_snapshots(workspace_id, content_id, captured_at);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT, claim_key TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, source TEXT,
  valid_from TEXT, valid_to TEXT, verified_at TEXT, verified_by TEXT, history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, url TEXT, media_id TEXT,
  client_id TEXT, status TEXT NOT NULL DEFAULT 'unsorted', suggestion TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_client ON inbox_items(workspace_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_id TEXT, content_id TEXT, kind TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL, sha256 TEXT NOT NULL, filename TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL,
  target_type TEXT, target_id TEXT, dedupe_key TEXT, deliver_after TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(workspace_id, dedupe_key, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  meta TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, task TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  rows TEXT NOT NULL, mapping TEXT, result TEXT, created_by TEXT, created_at TEXT NOT NULL
);

-- NetaMeguri 表記ゆれチェック: one notation dictionary per workspace (rules JSON, same shape as the dictionary file).
CREATE TABLE IF NOT EXISTS notation_dictionaries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, rules TEXT NOT NULL DEFAULT '[]', updated_by TEXT, updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  workspace_id UNINDEXED, ref_type UNINDEXED, ref_id UNINDEXED, title, body, tokenize = 'trigram'
);
`;
