# PROGRESS — 完成条件（仕様 §58）との対応

凡例: ✅ 実装・自動テスト済 / 🟡 実装済だが外部条件・人間確認が残る / ⬜ 未着手

| # | 完成条件 | 状態 | 根拠 / 残り |
|---|---|---|---|
| 1 | PC/iPhone/Android/iPad 主要UX | 🟡 | レスポンシブUI（サイドバー/ハンバーガー/ボトムナビ）。Chromiumエミュレーションで5端末・9画面の横スクロールなし・タップ領域を自動検証（e10）。**実機確認は未実施（人間作業）** |
| 2 | PWA | ✅ | manifest（maskable, shortcuts, share_target）、Service Worker（シェル/限定APIキャッシュ）、オフラインキュー（E2E-6, テスト33） |
| 3 | Workspace / RBAC | ✅ | owner/admin/editor/reviewer/viewer、外部投稿は個別付与（テスト30） |
| 4 | Brand Profile / Voice / Guard | ✅ | Voice Draft→人間確認、Guard個別チェック（テスト3） |
| 5 | Source ingestion | ✅ | Paste/URL(SSRF対策)/Transcript/File/Inbox、重複防止（テスト1,2,27） |
| 6 | Transcript optional | 🟡 | SRT/VTT/[mm:ss] 取込・字幕生成済。自動文字起こしは provider 実装済・**実API未検証** |
| 7 | Rights metadata | ✅ | owned/licensed/public_reference/unknown、第三者素材は引用制限＋注意表示 |
| 8 | Idea分離 | ✅ | ideas / idea_uses |
| 9 | Idea Fingerprint / Similarity | ✅ | 候補表示・自動削除なし（テスト5,6,7, E2E-2） |
| 10 | Freshness | ✅ | テスト8 |
| 11 | Content Pack | ✅ | テスト9, E2E-1 |
| 12 | Platform Transform | ✅ | テスト10 |
| 13 | Editor / Version / Approval | ✅ | 自動保存・版・AI提案保護・再レビュー（テスト4,11） |
| 14 | Campaign / Calendar | ✅ | 8段階計画・Guard・月表示（テスト12, E2E-3） |
| 15 | Scheduler / idempotency | ✅ | TZ/DST、二重投稿防止（テスト13,14, E2E-8） |
| 16 | Connector capability model | ✅ | adapter∩接続状態、公式docs調査は別表示（テスト15） |
| 17 | Manual Publish handoff | ✅ | Copy/Open/Mark Published、user_marked と api_confirmed を区別（テスト16） |
| 18 | Performance Snapshot | ✅ | テスト17, E2E-4 |
| 19 | Feedback Loop | ✅ | 期間・n・分母・因果否定（テスト18 + additional） |
| 20 | Recycling | ✅ | Reuse Rules、Needs Update 自動投稿禁止（テスト19,20, E2E-4） |
| 21 | Claim Registry | ✅ | 古い値警告、verified は人間のみ（テスト21, E2E-5） |
| 22 | Content Library / Search | ✅ | FTS + 構造化意図 + citation（テスト22） |
| 23 | Semantic optional | 🟡 | ローカル hashing vector（語彙近似）+ OpenAI embeddings 任意。**真の意味ベクトルの実API検証は未実施** |
| 24 | AI Strategist | ✅ | データ根拠・citation・fact guard（テスト23） |
| 25 | AI OFF / privacy | ✅ | テスト24、Brand/Source AI eligible |
| 26 | Import / Export | ✅ | CSV import(preview→mapping→duplicate→confirm)、CSV/JSON/MD/TXT/Pack ZIP/Copy ZIP/Campaign CSV（E2E-2, E2E-9） |
| 27 | MCP foundation | 🟡 | stdio MCP 12 tools、publish確認フロー（テスト34, E2E-7）。**Remote(HTTP)+OAuth、ChatGPT実機接続は未実施** |
| 28 | Security / SSRF / OAuth | ✅ | SECURITY.md（テスト25–30）。OAuth は Sandbox で検証、実Platform OAuth は未実施 |
| 29 | Backup / Restore / Audit | ✅ | 再採番復元・relation一致（テスト32, E2E-9）、監査ログ |
| 30 | 必須 / E2E / performance tests | ✅ | 必須34 + 追加12、E2E 9 + レスポンシブ5、性能試験（TEST_REPORT.md） |
| 31 | Branding / PWA assets | ✅ | brand/（横/縦/dark/mark）、favicon(svg/32)、apple-touch-icon、192/512/maskable、OG |
| 32 | 購入者資料 / 運用費 | ✅ | docs/buyer/*.txt（18ファイル）、OPERATING_COSTS.md |

## Phase 11 の残作業（人間）
実機確認、本番デプロイ（有料契約を伴う）、実SNSアカウント接続・実投稿、商標確認（名称は NetaMeguri に変更済み）。これらは仕様 §59 により人間の明示承認なしに行っていません。そのため **全体を「完成」とは報告しません**（完成条件 1, 6, 23, 27 に未検証部分あり）。
