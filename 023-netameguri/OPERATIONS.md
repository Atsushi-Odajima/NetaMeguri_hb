# OPERATIONS

## 構成（初版の推奨）
- 単一プロセス（Fastify + Worker）+ SQLite（WAL）+ ローカルディスク objects。小規模運用（数名・数千〜数万Content）向け。
- 前段に TLS 終端の reverse proxy（Caddy / nginx 等）。`NODE_ENV=production`, `HOST=127.0.0.1`。
- 本番では `NETAMEGURI_SECRET_KEY`（32文字以上のランダム）必須、`NETAMEGURI_SANDBOX=0`、`NETAMEGURI_SEED_DEMO=0` 推奨。

## 起動
```bash
npm ci && npm run build
NODE_ENV=production NETAMEGURI_SECRET_KEY=... NETAMEGURI_DATA_DIR=/var/lib/netameguri NETAMEGURI_SANDBOX=0 npm start
```

## バックグラウンドジョブ
| ジョブ | 間隔 | 内容 |
|---|---|---|
| runDueJobs | 30秒 | 予約投稿/手動リマインダー |
| connectorHealth | 1時間 | token期限通知・期限切れ化 |
複数インスタンスにする場合: ジョブは CAS claim で二重実行を防ぐが、SQLite は単一ホスト前提。Postgres へ移行し、ジョブは1インスタンスに限定するか分散ロックを使う。

## バックアップ
- アプリ内: Workspace単位の Backup ZIP（設定 → Import/Export）。schemaVersion / appVersion / checksum 付き。token は含まない。
- サーバー: `sqlite3 netameguri.db ".backup '/backup/cl-$(date +%F).db'"` を日次 + `objects/` を rsync / R2 等へ複製。
- 復元テスト: 新しいWorkspace（空）へ Backup ZIP を復元し、`GET /api/w/:id/relations` の件数が一致することを確認（E2E-9）。

## 監視
- `GET /api/health`
- 失敗ジョブ: `publish_jobs.status='failed'` 件数、通知 `schedule_failed`
- AI費用: `ai_usage` の月次合計（設定画面にも表示）
- ディスク: `data/` サイズ（性能試験: 2M content + 20M snapshots で TEST_REPORT.md 参照）

## データ削除（退会・依頼対応）
1. Source単位: アプリから削除（transcript/vector/index/media も削除）。
2. Workspace単位（UI未提供）: メンテナンス時に以下を実行し、`objects/<workspaceId>/` を削除。
```sql
DELETE FROM search_fts WHERE workspace_id = :ws; DELETE FROM embeddings WHERE workspace_id = :ws;
DELETE FROM notifications WHERE workspace_id = :ws; DELETE FROM audit_logs WHERE workspace_id = :ws;
DELETE FROM transcript_segments WHERE workspace_id = :ws; DELETE FROM idea_uses WHERE workspace_id = :ws;
DELETE FROM workspaces WHERE id = :ws;  -- 主要表は ON DELETE CASCADE
```
3. 外部AIプロバイダ側の保持ポリシーは各社規約に従う（Privacy.txt に記載）。

## インシデント
- 二重投稿の疑い: 該当 `publish_jobs` の idempotency_key / external_id を確認。Worker は再試行前にリモート照会するため、照会不能な adapter では自動再送しない。
- token漏えいの疑い: `NETAMEGURI_SECRET_KEY` をローテーション（既存tokenは復号不可になるため全Connector再接続）、各Platformでアプリ連携を取り消し。
