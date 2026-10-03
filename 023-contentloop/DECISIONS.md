# DECISIONS — 設計判断の記録

| # | 判断 | 理由 / トレードオフ |
|---|---|---|
| D1 | Node 22 + TypeScript + Fastify 5 / React 19 + Vite 7 | 単一言語でサーバー・PWA・MCPを共有。依存を最小化。 |
| D2 | DB は `node:sqlite`（WAL）+ FTS5 trigram | ネイティブビルド不要で配布容易。小規模運用（仕様の想定規模）で十分な性能（TEST_REPORT.md）。全SQLはbind parameter。`DB` クラスを薄く保ち、Postgres実装へ差し替え可能にした（マルチインスタンス運用時は Postgres + pgvector を推奨）。 |
| D3 | 既定AIは「ローカル抽出エンジン」 | 素材の文を再配置＋中立的な枠組みだけで下書きを作るため、虚偽の体験談・数値を作らない。外部AIなしでも全機能が動く。外部AIは `AIGateway` 1か所経由（AI OFF/対象外/上限/fact guard を強制）。 |
| D4 | Idea と Content を分離 | ネタの使用履歴（idea_uses）を Platform 横断で持ち、重複・再利用判定の単位にする。 |
| D5 | Fingerprint = 文字trigram(上位160, ハッシュ) + キーワード | 日本語でも形態素解析なしで動く。類似は `0.6*cosine + 0.4*sqrt(jaccard)`。しきい値 related 0.22 / similar 0.40 / very_similar 0.58。**候補表示のみで自動削除・統合はしない。** |
| D6 | Semantic は optional | 既定はローカル hashing vector（語彙近似であり真の意味ベクトルではない、と明記）。OpenAI embeddings は設定時のみ。大規模時は FTS で候補を絞ってから比較。 |
| D7 | Platform Profile と Connector Capability を分離 | 「書き方の仕様」と「APIで投稿できるか」は別問題。Capability は adapter 実装 ∩ 接続状態で決まり、公式docs調査結果（API_FACTS）は参考表示のみ。 |
| D8 | 実SNS adapter は初版で実装しない（WordPressのみ実装・未検証） | 実アカウント接続・実投稿は人間承認が必要なため。代わりに Sandbox adapter で失敗注入（auth/429/曖昧エラー）を含めて安全機構を検証。 |
| D9 | 二重投稿防止 = idempotency key + 再試行前のリモート照会 + CAS claim | 曖昧なエラー（送信後タイムアウト）は盲目的に再試行しない。照会できない adapter は失敗として人間に委ねる。 |
| D10 | 承認後の編集は再レビュー（設定で変更可）＋予約ジョブ取消 | 承認した版と投稿する版の一致を保証（job.content_version）。 |
| D11 | Claim の verified は人間のみ | MCP/AI経由（`via=mcp` や system）では verify 不可。値変更で verified をリセット、古い値を含む Idea/Content を Needs Update/再レビューへ。 |
| D12 | Performance はPlatform間で合算しない | 指標定義が異なるため `crossPlatformTotal: null`。傾向は median engagement・件数・期間・分母を表示し、因果を主張しない。 |
| D13 | OAuth token は AES-256-GCM で暗号化保存、API応答に含めない | `connectorView` が唯一の公開表現。鍵は `CONTENTLOOP_SECRET_KEY`（本番必須）。 |
| D14 | Backup は JSON in ZIP（schemaVersion/appVersion/checksum）、復元時に全IDを再採番 | 同一DBへの複製復元・新環境への復元の両方に対応。tokenは含めない。メディアは別戦略。 |
| D15 | PWA オフラインは「Quick Capture」「Draft編集」のみキュー化 | 投稿/予約はオフラインで確定しない。Draftは expectedVersion 付きで送り、競合は上書きせずユーザー確認。 |
| D16 | MCP 投稿は prepare → 確認コード → userApproved → 設定許可 | AIが勝手に投稿しない。確認コードは単回・10分・本文ハッシュ一致必須。 |
| D17 | ロゴは独自の「開いたループ＋流れの矢じり」 | recycleマークを避け、content flow を表現。ワードマークは DejaVu Sans で画像化（フォントファイル非同梱）。 |
| D18 | 名称は変更しない | 類似名称あり（SOURCE_NOTES §7）。仕様どおり候補名の決定は人間確認。 |
