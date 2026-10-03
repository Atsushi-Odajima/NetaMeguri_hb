# CAMPAIGNS — Campaign / Calendar / Scheduler / Series / Brief

実装: `server/src/domain/campaigns.ts`, `publish.ts`

## Campaign
`name / objective / startDate / endDate / product / audience / keyMessages / sources / channels / status`。
「8段階のDraft計画」: Teaser → Problem → Story → Demo → Release → Use Case → FAQ → Reminder を期間内に均等配置し、channel と key message を巡回で割当（推奨angle付き）。各ステップから「Draftを作る」で、Campaign素材のIdea（stageのangle・key messageに近いもの、Campaign内で未使用を優先）からDraftを作成。

## Campaign Guard（ヒント表示。「最適」とは言わない）
- 同じIdeaが7日以内に複数回 / 本文が非常に近い投稿（類似度≥0.58）
- Key Message を扱う投稿がない
- Platform偏り（60%超）・予定Channelの未使用
- 未使用Source
- 投稿未作成のステップ（→ `campaign_gap` 通知、24h dedupe）

## Calendar
Draft/Approved/Scheduled/Published/Failed を月表示（スマホは一覧）。Workspace タイムゾーンで表示。⚡=API予約、✋=手動投稿リマインダー、点線=未作成の計画ステップ。

## Scheduler / PublishJob
- 入力はローカル時刻 + タイムゾーン（IANA）→ UTC で保存（DST考慮、テスト13）。
- `mode=api`: Connector の PUBLISH が有効・Approved・外部投稿権限・block なし・Needs Update でない場合のみ。
- `mode=manual`: 指定時刻に「手動投稿の時間です」通知（handoff）。
- idempotency key = sha256(workspace|content|version|platform|scheduledAt)（UNIQUE）。同条件の再予約は既存ジョブを返す。
- Worker（30秒間隔）: CAS で queued→running、承認版と一致確認、block/Needs Update 再確認、再試行時はリモート照会で二重投稿防止、429 は指数バックオフ（最大5回）、auth エラーは Connector を expired にして停止、曖昧エラーは盲目的に再試行しない（CONNECTORS.md）。

## Series / Brief
- Series: theme / cadence / format / Idea pool。Series内のIdea同士の類似（≥0.40）を表示。
- Brief: objective / audience / message / CTA / platform / sources / constraints。Pack 作成時に Brief を指定すると外部AIのプロンプト文脈に含めます。
