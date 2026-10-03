# PERFORMANCE_LOOP

実装: `server/src/domain/performance.ts`

## Snapshot
`PerformanceSnapshot { contentId, platform, capturedAt, window(24h/7d/30d/custom), metrics, source(connector/csv/manual) }`
指標キー: impressions / views / reach / likes / comments / shares / saves / clicks / watch_time_sec / followers_delta（未知のキーは破棄）。
取得経路: 手入力（エディタ「反応」タブ）、CSV Import、Connector（ANALYTICS_READ を持つ adapter のみ。本ビルドでは Sandbox）。

## 合算しない
Platformごとに指標定義が異なるため、`performanceSummary` は Platform 別の合計・median engagement のみ返し `crossPlatformTotal: null`（テスト18）。各 Platform の定義メモを表示。

## Engagement rate（1投稿・1Platform内）
`(likes+comments+shares+saves+clicks) / (impressions → views → reach の最初に存在する値)`。分母が無い場合は算出しない。

## Feedback Loop
Topic / Angle / Format / Platform / 長さ / CTA有無 / Hook 別に median engagement と件数 n を表示。
例: 「過去90日、Topic『リリース』は他よりmedian engagementが高い傾向でした（リリース: n=3、全体: n=8、分母=impressions/views）。相関であり因果関係や将来の成果は保証しません。」
- n < 3 のグループは「件数不足」として結論に使わない。
- 期間・件数・分母を常に表示。「バズる」等の保証表現は使わない。

## High Performer 判定
同一Platformの他投稿（3件以上）の median engagement の1.5倍以上 → `recycle_state=high_performer`（記録時に自動分類。手動変更可）。
