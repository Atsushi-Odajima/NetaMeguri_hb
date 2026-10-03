# PLAN — NetaMeguri #023

## 目的
「生成量」ではなく、1素材から価値を何度も引き出し、無自覚なネタ重複を防ぎ、良いコンテンツを再利用する運用ループを1周させる。

## アーキテクチャ（初版）

```
web/ (React 19 + Vite PWA) ──HTTP(JSON, cookie session + CSRF)──> server/ (Fastify 5, Node 22)
                                                              ├─ domain/   業務ロジック（全関数が Ctx = workspace+role を受け取る）
                                                              ├─ ai/       local抽出エンジン / AIGateway(provider抽象) / transcription
                                                              ├─ connectors/ Capability model + Manual / Sandbox / WordPress adapter
                                                              ├─ db/       node:sqlite (WAL) + FTS5 trigram
                                                              ├─ lib/      SSRF guard, CSV/ZIP安全化, 暗号化, TZ, Storage(signed URL)
                                                              └─ mcp/      MCP tools (stdio)
```

## Phase 計画と状態（詳細は PROGRESS.md）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 市場/名称/技術/provider/SNS API/license/料金調査、PoC | 済（SOURCE_NOTES.md。名称の法務確認は人間待ち） |
| 1 | Auth, Workspace, RBAC, Brand Profile/Voice | 済 |
| 2 | Source ingestion, Transcript, Rights, Library | 済（自動文字起こしは provider 実装済・実API未検証） |
| 3 | Idea, Fingerprint, Similarity, Freshness | 済 |
| 4 | Content Pack, Platform Profiles, Editor, Approval | 済 |
| 5 | Campaign, Calendar, Scheduler, Manual Publish | 済 |
| 6 | Connector capability, OAuth, Publish queue | 済（Sandbox/WordPressのみ。実SNS接続は人間承認待ち） |
| 7 | Performance Snapshot, Feedback Loop, Recycling | 済 |
| 8 | Search/Semantic, AI Strategist, Claim Registry | 済（Semanticはローカル近似 + OpenAI embeddings 任意） |
| 9 | PWA, Import/Export, MCP foundation | 済 |
| 10 | Privacy/Security/Backup/Audit/Performance | 済（性能はローカル計測） |
| 11 | PC/iPhone/Android/iPad E2E, Branding, Docs, Deploy, 販売前check | 一部（実機確認・本番Deploy・商標確認は人間作業） |

## 今回広げないもの（仕様 §51）
本格動画editor、Canva代替、画像editor、広告運用、自動DM、フォロワー購入、engagement bot、scraping、非公開API、無断転載、虚偽testimonial、CRM、会計。
