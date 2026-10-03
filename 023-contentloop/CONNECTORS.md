# CONNECTORS — Capability model / OAuth / Publish safety

実装: `server/src/connectors/registry.ts`, `server/src/domain/publish.ts`。公式API調査: SOURCE_NOTES.md（確認日 2026-10-02、一部は検索抜粋ベース[S]で要再確認）。

## Capability
`READ / ANALYTICS_READ / DRAFT_EXPORT / SCHEDULE / PUBLISH / DELETE / UNAVAILABLE`

**有効Capability = adapter が実装している ∩ 接続状態が connected。** 手動投稿（DRAFT_EXPORT）は常に可能。APIがない・未接続のPlatformで自動投稿可能と表示しません（テスト15）。
画面「SNS Connector」は「今できること」と「公式APIの調査メモ（docs/条件付き/未確認/なし）」を分けて表示します。

## 本ビルドの adapter
| adapter | Platform | 実装Capability | 状態 |
|---|---|---|---|
| manual:* | 全Platform | DRAFT_EXPORT | Copy text / Download media / Open platform / Mark Published |
| sandbox:threads/x/linkedin/instagram | 4 | READ, ANALYTICS_READ, SCHEDULE, PUBLISH, DELETE | **シミュレーション**（実SNSに接続しない）。失敗注入で安全機構を検証 |
| wordpress | Blog | READ, DRAFT_EXPORT, SCHEDULE, PUBLISH, DELETE | REST API + Application Password。**実サイト未検証**。接続には `confirmRealAccount` の明示が必要 |

実SNS（Threads/X/LinkedIn/Instagram/Facebook/TikTok/YouTube）の本番 adapter は未実装です。実装時は SOURCE_NOTES.md の scope・審査・rate limit・料金（Xの従量課金等）を再確認し、人間の承認後に実アカウントで検証します（RELEASE_CHECKLIST.md）。

## 公式APIの調査結果（要約、SOURCE_NOTES.md §2）
| Platform | PUBLISH | SCHEDULE(native) | ANALYTICS | 備考 |
|---|---|---|---|---|
| Threads | 条件付き（App Review, 250/24h） | 未確認 | 可 | |
| X | 条件付き（従量課金） | v2なし | 可（自投稿） | 投稿ごと課金 |
| LinkedIn | 条件付き（会員 w_member_social / 組織は承認） | 未確認 | 条件付き | |
| Instagram | 条件付き（Professional + App Review） | 未確認 | 可 | 投稿上限の記載差あり |
| Facebook Pages | 条件付き | 可 | 可（指標移行中） | |
| TikTok | 条件付き（audit前は SELF_ONLY） | 未確認 | 基本値のみ | 初期は下書き送付が現実的 |
| YouTube Shorts | 条件付き（未監査は private） | 可（publishAt） | 可 | quota |
| YouTube Community | **不可（APIなし）** | 不可 | - | 手動のみ |
| WordPress | 可 | 可（status=future） | なし | |
| Buttondown | 可 | 可 | 条件付き | |

## OAuth / Token
- state（10分）+ PKCE（S256）。callback は開始ユーザー本人のセッションのみ受理。
- scope は Platform ごとの最小（API_FACTS.scopes）。
- token/refresh は AES-256-GCM で暗号化保存（鍵 `CONTENTLOOP_SECRET_KEY`）。API応答・ログ・バックアップに含めない（テスト25）。
- Revoke: リモート revoke（best-effort）→ ローカル token 削除 → queued API ジョブを failed（テスト26）。
- Health: 期限7日前に通知、期限切れで `expired`。auth エラー時も `expired` にし、自動再試行しない。

## Publish safety
- 二重投稿防止: idempotency key、CAS claim、再試行前に `findByIdempotency` でリモート照会（テスト14, E2E-8）。照会できない adapter は自動再試行せず人間に委ねる。
- 429: `retry-after` を基に指数バックオフ（上限1時間・最大5回）。ローカル token bucket（30/分/connector）。無限再試行しない。
- 曖昧エラー（送信後タイムアウト等）: 1回照会し、見つからなければ failed（盲目的に再送しない）。
- 大量自動投稿・engagement bot・非公開API・scraping は製品価値にしない（実装なし）。
