# DEVELOPMENT

## 必要環境
- Node.js 22.13+（`node:sqlite` を使用。起動時に ExperimentalWarning が出ます）
- Chromium（E2E・ブランド素材生成。`PLAYWRIGHT_BROWSERS_PATH` を利用）

## コマンド
| コマンド | 内容 |
|---|---|
| `npm run dev` | API(8787, tsx watch) + Vite(5173, /api proxy) |
| `npm run build` | PWA を `dist/web` にビルド |
| `npm start` | 本番モードで起動（`dist/web` を配信） |
| `npm run typecheck` | `tsc --noEmit`（server/web/tests 全体） |
| `npm test` | 必須テスト 1–34 + 追加（vitest） |
| `npm run test:e2e` | E2E-1〜9 + レスポンシブ（Playwright。専用データディレクトリ `.e2e-data` を毎回作り直す） |
| `SCALE=1 npm run perf` | 性能試験（100k/500k/2M/20M）。結果は `perf-results.json` |
| `npm run assets` | ロゴ/PWAアイコン/OG画像を再生成 |
| `npm run mcp` | MCP stdio サーバー（環境変数は MCP_PLUGIN.md） |

## 環境変数
| 変数 | 既定 | 説明 |
|---|---|---|
| `PORT` / `HOST` | 8787 / 127.0.0.1 | |
| `CONTENTLOOP_DATA_DIR` | ./data | SQLite と objects（メディア） |
| `CONTENTLOOP_SECRET_KEY` | (dev固定鍵) | **本番必須**。OAuth token 暗号化・署名URL |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | - | 設定画面で provider=anthropic のとき使用 |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | - | provider=openai / embeddings=openai |
| `CONTENTLOOP_ENABLE_TRANSCRIPTION` | - | `1` で OpenAI 文字起こし provider を有効化 |
| `CONTENTLOOP_ALLOW_SAMPLE` | dev:有効 | 本番でサンプルWorkspace作成を許可する場合のみ `1` |
| `CONTENTLOOP_SEED_DEMO` | dev:有効 | `0` で初回デモユーザー作成を抑止 |
| `CONTENTLOOP_SANDBOX` | 有効 | `0` で Sandbox connector を無効化（本番推奨） |
| `CONTENTLOOP_AUTH_RATE_IP` / `_EMAIL` | 20 / 10 | ログイン試行の毎分上限 |
| `CONTENTLOOP_TEST_MODE` | - | E2E専用（時計の前進・失敗注入）。`NODE_ENV=production` では無効 |

## ディレクトリ
```
server/src/
  api/server.ts        HTTPルート・認証・CSRF・CSP・レート制限
  domain/*.ts          業務ロジック（workspace, brand, sources, ideas, content, publish, performance, campaigns, claims, search, io, misc, notifications）
  ai/local.ts          ローカル抽出エンジン（解析・変換）
  ai/gateway.ts        外部AIの唯一の入口（AI OFF/対象外/上限/fact guard）
  ai/transcription.ts  文字起こし provider 抽象 + SRT/VTT 解析・生成
  connectors/registry.ts  Capability model / Manual / Sandbox / WordPress
  mcp/tools.ts, stdio.ts  MCP
  seed/sample.ts       サンプルWorkspace（架空ブランド）
web/src/               PWA（pages/*、offline.ts、api.ts）
web/public/            manifest, sw.js, icons
tests/unit/            必須テスト（required.test.ts）
tests/e2e/             E2E
scripts/               perf.ts, render-assets.mjs, smoke.ts
```

## コーディング規約
- 業務関数は必ず `Ctx` を受け取り、最初に `requirePerm` を呼ぶ。テナント取得は `getScoped`（他テナントは 404）。
- 外部AI呼び出しは `ctx.app.ai.run()` のみ。直接 fetch しない。
- 監査ログ（`audit`）に本文・秘密情報を入れない。
