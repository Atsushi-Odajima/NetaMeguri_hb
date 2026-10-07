# DATA_MODEL

全テーブルは `workspace_id` を持ち、全クエリで絞り込みます（定義: `server/src/db/schema.ts`, schemaVersion=1）。

## 主要エンティティ

| テーブル | 主な列 | 備考 |
|---|---|---|
| organizations / workspaces | settings(JSON), timezone, is_sample | settings: AI ON/OFF, provider, cost cap, 承認ルール, reuseRules, packDefaults, quietHours, mcpPublishAllowed |
| users / sessions / memberships | role(owner/admin/editor/reviewer/viewer), can_publish_external | 外部投稿権限は Editor に自動付与しない |
| brands | voice_summary, tone, banned_terms, banned_ctas, emoji_policy, max_emoji, hashtags_policy, examples_good/bad, voice_status(unset/draft/confirmed), voice_draft, ai_eligible, locale_profiles | |
| sources | type, title, url, text, duration_sec, author, published_at, imported_at, language, rights_status(owned/licensed/public_reference/unknown), rights_note, attribution, status, content_hash, ai_eligible, evergreen, analysis(JSON) | content_hash で重複取込防止（workspace内 unique） |
| transcript_segments | idx, start_ms, end_ms, text, inaudible | 聞き取れない箇所は inaudible=1（補完しない） |
| ideas | core_idea, angle, topic, source_ids, status(new/used/reusable/overused/retired/needs_update), first/last_used_at, use_count, fingerprint(JSON), embedding_ref, evergreen, series_id, origin | Content と分離 |
| idea_uses | idea_id, content_id, platform, used_at | Recently Used / 同一Platform窓の判定 |
| embeddings | ref_type, ref_id, model, vector | Source削除時に削除 |
| content_packs | source_ids, brand_id, campaign_id, brief_id, generation_config, generator | |
| content_items | pack_id, idea_id, source_ids, platform, format, title, body, structured(JSON: slides/clip/notes), status, scheduled_at, published_at, published_via(user_marked/api_confirmed/imported), external_post_id, human_edited, ai_suggestion, version, approved_version, recycle_state, locale, parent_content_id | |
| content_versions | version, body, author_type(ai/human/import) | 全編集履歴 |
| approvals / comments | action(review_requested/approved/changes_requested/invalidated_by_edit) | |
| campaigns / campaign_steps | key_messages, channels, stage(teaser…reminder), planned_date | |
| series / briefs | | |
| connectors | adapter, status(connected/expired/revoked), token_enc, refresh_enc(AES-256-GCM), scopes, health | API応答に token を含めない |
| publish_jobs | mode(api/manual), scheduled_at(UTC), timezone, status(queued/running/published/failed/handoff/cancelled), attempt, idempotency_key(UNIQUE), external_id, content_version, next_attempt_at | |
| performance_snapshots | content_id, platform, captured_at, window(24h/7d/30d/custom), metrics(JSON), source(connector/csv/manual) | Platform間で合算しない |
| claims | claim_key, label, value, source, valid_from/to, verified_at/by, history(JSON) | verified は人間のみ |
| inbox_items | kind, text, url, media_id, client_id(UNIQUE per ws), suggestion | オフライン再送の冪等性 |
| media_assets | kind, mime, size, storage_key, sha256 | storage key はサーバー生成、署名URLで配信。content_id の画像は NetaMeguri 納品パックの画像になる |
| notation_dictionaries | workspace_id(UNIQUE), name, rules(JSON: ruleId/correct/variants/caseSensitive/matchMode/enabled), updated_by/at | NetaMeguri 表記ゆれチェックの辞書（Workspaceに1つ）。バックアップ対象 |
| notifications | dedupe_key, deliver_after | 24h dedupe・毎時上限・quiet hours |
| audit_logs | actor_id, action, target, meta | 本文/秘密は入れない |
| ai_usage | provider, task, tokens, cost_usd | 月次上限判定 |
| import_batches | rows, mapping, result | Import→preview→mapping→duplicate→confirm |
| search_fts (FTS5 trigram) | ref_type, ref_id, title, body | Source/Idea/Content |

## 関係
```
Source 1─* Idea (ideas.source_ids) ─* ContentItem ─* Version / Approval / Comment / PublishJob / PerformanceSnapshot
ContentPack 1─* ContentItem      Campaign 1─* CampaignStep ─0..1 ContentItem      Idea 1─* IdeaUse
ContentItem ─ parent_content_id → ContentItem（変換・再利用・翻訳の元）
```

## 削除時の扱い
| 対象 | DB | storage | vector | 検索index | 備考 |
|---|---|---|---|---|---|
| Source | 行・transcript削除 | 紐づくメディア削除 | 削除 | 削除 | 派生Idea/Contentは残る（source_idsは参照切れとして表示） |
| Workspace | UI/APIは未提供。運用者が OPERATIONS.md の手順で削除（主要表は ON DELETE CASCADE、embeddings/search_fts/notifications/audit は手動SQL） | objects/<workspaceId>/ を削除 | 手動SQL | 手動SQL | 退会時手順に記載 |
| Connector revoke | token列をNULL | - | - | - | リモート revoke は best-effort |
| ブラウザ | - | - | - | - | ログアウト時に Service Worker のAPIキャッシュを削除 |
