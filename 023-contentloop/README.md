# ContentLoop（#023）— AIコンテンツ再利用・SNS運用OS

> 1個作ったコンテンツを、1回で終わらせない。

動画・記事・PDF・音声などの素材（Source）から、SNS別の投稿案（Content Pack）を作り、使ったネタ（Idea）を覚えて重複を防ぎ、反応（Performance）を見て良いネタを再利用（Recycling）するコンテンツ運用ツールです。

```
Source取込 → 解析 → Brand Voice → Idea抽出 → Content Pack → Platform別Draft → Idea Fingerprint重複確認
→ Review → Campaign → Schedule / Export / Publish → Performance取込 → Recycling候補 → 次のDraft
```

## クイックスタート

```bash
cd 023-contentloop
npm install
npm run build          # PWA(web) をビルド → dist/web
npm start              # http://127.0.0.1:8787  (開発環境ではサンプルWorkspaceを自動作成)
# demo@sample-build-lab.invalid / demo-password-123
```

開発時は `npm run dev`（API: 8787 / Vite: 5173）。テストは `npm test`（必須テスト）と `npm run test:e2e`（E2E）。

## ドキュメント

| 種類 | ファイル |
|---|---|
| 計画・進捗・判断 | [PLAN.md](PLAN.md) / [PROGRESS.md](PROGRESS.md) / [DECISIONS.md](DECISIONS.md) / [NEXT_STEPS.txt](NEXT_STEPS.txt) |
| 開発 | [DEVELOPMENT.md](DEVELOPMENT.md) / [DATA_MODEL.md](DATA_MODEL.md) |
| 機能仕様 | [BRAND_VOICE.md](BRAND_VOICE.md) / [IDEA_FINGERPRINT.md](IDEA_FINGERPRINT.md) / [CONTENT_PACK.md](CONTENT_PACK.md) / [PLATFORM_PROFILES.md](PLATFORM_PROFILES.md) / [CAMPAIGNS.md](CAMPAIGNS.md) / [PERFORMANCE_LOOP.md](PERFORMANCE_LOOP.md) / [RECYCLING.md](RECYCLING.md) / [CONNECTORS.md](CONNECTORS.md) / [MCP_PLUGIN.md](MCP_PLUGIN.md) |
| 安全・運用 | [AI_SAFETY.md](AI_SAFETY.md) / [SECURITY.md](SECURITY.md) / [OPERATIONS.md](OPERATIONS.md) / [OPERATING_COSTS.md](OPERATING_COSTS.md) |
| 検証・リリース | [TEST_REPORT.md](TEST_REPORT.md) / [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) / [SOURCE_NOTES.md](SOURCE_NOTES.md) |
| 購入者向け | [docs/buyer/](docs/buyer/) |
| ブランド素材 | [brand/](brand/)・`web/public/icons/` |

## 重要な前提

- 実SNSアカウントへの接続・実投稿・有料契約・本番公開は、人間の明示承認なしに行いません。本ビルドの自動投稿は **Sandbox（シミュレーション）** のみで検証しています。
- 既定のAIは **ローカル抽出エンジン**（外部送信なし）。外部AI（Anthropic/OpenAI）はサーバー環境変数のAPIキーと設定で有効化します。
- 製品名「ContentLoop」は類似名称が存在します（SOURCE_NOTES.md §7）。名称・商標は販売前に人間/法務確認が必要です（勝手に変更していません）。
