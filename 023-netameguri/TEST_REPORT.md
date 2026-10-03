# TEST_REPORT（実行日 2026-10-03）

環境: Linux コンテナ / 4 vCPU (Xeon 2.1GHz) / 17GB RAM / Node v22.22.0 / Chromium (Playwright 1.56)

## 結果サマリ
| 種別 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | エラー 0 |
| 必須テスト 1–34 + 追加 | `npm test` | **47 / 47 passed**（required 39 + extra 8） |
| E2E-1〜9 + レスポンシブ5端末 + 日本語日付入力 | `npm run test:e2e` | **15 / 15 passed** |
| 性能試験（SCALE=1） | `SCALE=1 npm run perf` | 下表（`perf-results.json`） |

## 必須テスト対応（tests/unit/required.test.ts）
01 Source import / 02 重複取込防止 / 03 Brand禁止語 / 04 再生成で人間編集保持 / 05 類似候補 / 06 同一Idea非削除 / 07 Recently Used（「18日前にThreadsで使用したIdeaと非常に近いです。」）/ 08 Freshness / 09 Pack relation / 10 Transform relation / 11 承認後編集→再レビュー / 12 Campaign重複警告 / 13 TZ・DST / 14 再試行で二重投稿なし / 15 capabilityなしで自動投稿なし / 16 user_marked vs api_confirmed / 17 Snapshot / 18 Platform合算なし / 19 Recycling rule / 20 Needs Update自動投稿禁止 / 21 Claim古い値 / 22 Search citation / 23 架空実績を作らない / 24 AI OFF→provider 0 / 25 token非露出 / 26 revoke / 27 SSRF / 28 CSV injection / 29 ZIP traversal / 30 tenant A→B拒否・CSRF・RBAC / 31 Source削除でvector削除 / 32 Backup/Restore relation一致 / 33 PWAオフラインDraft / 34 MCP publish前確認 — **すべて pass**

追加: 認証失効→再認証→重複なし再実行、429バックオフ、CSV import→類似警告、Feedbackの注意書き、Claim更新→Needs Update、通知（dedupe/上限/quiet hours）、MIMEマジックバイト、署名URL期限、SRT/VTT字幕、UTM、Quick Capture冪等、AI非対象Sourceは外部送信0。

## E2E（tests/e2e）
| # | シナリオ | 結果 |
|---|---|---|
| 1 | 動画(Transcript)登録→Ideas→Pack→Threads/LinkedIn/Blog Draft→Review→Approved | pass |
| 2 | 過去Threads CSV import→Fingerprint→類似警告→別angle Draft（CSV injection無害化も確認） | pass |
| 3 | Launch Campaign→8段階→Sandbox OAuth→API予約+手動予約混在→Calendar表示 | pass |
| 4 | 公開→24h/7d Snapshot→High Performer→(+61日)→Recycling→別Platform Draft | pass |
| 5 | 価格変更→Claim更新→古いContentが再レビュー/Evergreen IdeaがNeeds Update | pass |
| 6 | iPhoneエミュレーションでオフラインQuick Capture/Draft編集→再接続同期→PCでSource化→Draft review | pass |
| 7 | MCP stdio 実クライアント: 未使用Idea→Draft→checks→handoff→承認+設定+確認コードで投稿 | pass |
| 8 | Connector認証失敗→failed→再認証→再実行（リモート投稿は1件のみ） | pass |
| 9 | Backup→新規ユーザーの空Workspaceへ復元→relation一致・検索可・Connector要再接続 | pass |
| R | iPhone 13 / Pixel 7 / iPad / iPad横 / PC1366 × 9画面で横スクロールなし・ナビ表示・タップ領域≥44px | pass |
| J | 英語ロケールのブラウザでも日付・時刻が日本語（年/月/日・時/分）で表示され、標準の日付入力を使わない | pass |

## 性能試験（SCALE=1: Sources 100k / Ideas 500k / Content 2M / Snapshots 20M、DB 8.5GB）
| 測定 | p50 | p95 |
|---|---|---|
| Library検索（FTS + semantic + 意図解析） | 433 ms | 540 ms |
| Idea類似チェック（FTS候補→語彙→ベクトル） | 197 ms | 254 ms |
| Calendar 月表示（上限1,500件） | 47 ms | 70 ms |
| Content一覧（status+platform） | 0.1 ms | 1.1 ms |
| Performance summary（30日・約10万公開投稿） | 2.35 s | 2.43 s |
| Feedback Loop topic（30日） | 2.61 s | 2.77 s |
| ローカル解析（40文） | 5.5 ms | 16 ms |
| ローカル変換（Threads 1件） | 0.2 ms | 0.3 ms |
| ローカル埋め込み（1文） | <0.1 ms | <0.1 ms |
| Queue 1,000件処理（connector毎30件/分の制限で30件投稿・残りは再キュー） | 304 ms（総計） | - |
| Connector polling（Sandbox, 1件） | <0.1 ms | <0.1 ms |
| Media upload 5MB（検証+hash+保存） | 35 ms | 60 ms |
データ生成: sources 6s / ideas(+fingerprint+vector) 48s / content 98s / snapshots 206s。

改善履歴: 初回計測で Queue 1,000件が 357秒（1%規模）→ 公開時の類似チェック省略とN+1解消で 0.3秒、Calendar 3.0秒→47ms（式インデックス+上限）、Content一覧 105ms→0.1ms（複合インデックス）。

**注意**: これはこの環境での生成データによる計測で、販売保証値ではありません。30日で約10万件の公開投稿を集計する Performance/Feedback は2秒台（小規模運用の想定を大きく超える量）。大規模利用時は集計キャッシュ/Postgres移行を推奨（NEXT_STEPS.txt）。外部AI・文字起こし・実SNS APIの遅延は未計測（実API未接続）。

## 未検証（人間の確認が必要）
- 実機（iPhone/Android/iPad/PC）での操作・PWAインストール・共有ターゲット（テストはChromiumエミュレーション）
- 実SNS API / WordPress 実サイト / 外部AI / 文字起こしAPI の実呼び出し（Sandbox・フェイクproviderでのみ検証）
- ChatGPT からの MCP 接続（本ビルドは stdio。Claude Code 等の stdio クライアントで動作する設計、E2E は SDK クライアントで検証）
- WebKit(Safari)・Firefox でのE2E（Chromiumのみ）
