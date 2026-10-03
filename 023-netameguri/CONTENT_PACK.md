# CONTENT_PACK — Content Pack / Platform Transform / Editor / Approval

実装: `server/src/domain/content.ts`, `server/src/ai/local.ts#transform`

## Content Pack
1つ以上の Source → 複数 ContentItem。既定数（設定で変更可）:
short_video 8 / threads 12 / x 15 / linkedin 5 / instagram_carousel 3 / blog 2 / newsletter 1 / quote 14。

- Source に Idea が無ければ自動抽出。Idea を巡回し、同じ Idea を同じ Pack で再利用する場合は variant を変えて文面を変える。
- Carousel には How-to/Checklist/比較の Idea を優先。
- 各 item は `pack_id / idea_id / source_ids / platform / format` を保持（テスト9）。
- Pack ZIP エクスポート（manifest.json + platform/NNN-format.txt + slides.json）。

## Platform Transform（同じIdeaをコピペしない）
| format | 生成内容 |
|---|---|
| post / thread | hook（angle別の中立的な枠組み）+ coreIdea + 補足文（素材から抽出）+ CTA + hashtag。Platform推奨長に収め、上限超過時は文単位で切り詰め |
| carousel | Cover → Problem → Points(≤3) → Summary → CTA の slide text/spec + caption |
| short_video | start/end（Transcriptのtimestampから20–45秒）、hook、topic、whyUseful、captionDraft。SRT/VTT字幕Draftを生成可能 |
| article (blog) | タイトル、導入、要点、ポイント見出し（素材の再構成）、まとめ、出典リスト |
| newsletter | 件名、プレビュー文、本文、出典 |
| quote | 短い引用 + 出典（作者・素材名） |

- hook は「〜のやり方を短くまとめます」等の中立表現のみで、体験・実績を新たに作りません。
- 権利が public_reference / unknown の素材は補足文を1文に制限し、引用は短く・出典明記・人間確認の注意を付けます。
- 外部AIが有効な場合のみ、ローカル下書きを AI が整えます（fact guard 適用、AI_SAFETY.md）。

## Editor
- 自動保存（1.5秒デバウンス、同一ユーザー2分以内は版を統合）、「版として保存」で明示的な版。
- 文字数（X は重み付け近似）、Platformプレビュー、Carouselスライドプレビュー。
- チェック: Brand Guard / ネタ重複 / 再利用ルール / Freshness / Claim / 出典。
- **AI再生成は人間の編集を消さない**: 人間が編集済み・承認済みの場合、結果は「AIの提案」として保存し本文は変更しない（テスト4）。採用は明示操作。
- 楽観ロック（expectedVersion）。競合時は上書きせず通知。
- 版履歴（AI Draft / 人間の編集 / Import）と復元。

## Approval
Draft → レビュー依頼（Needs Review）→ 承認（Reviewer/Admin/Owner）→ Approved。修正依頼で Draft に戻る。
- 承認時にチェックを再実行し、block があれば承認不可。
- `requireApprovalBeforePublish`（既定ON）: API投稿・公開済み登録には Approved 必須。
- `reReviewOnEditAfterApproval`（既定ON）: 承認後に本文/タイトルを変えると Needs Review に戻し、予約ジョブを取消（テスト11）。
- 履歴（approvals）に actor / version / comment を記録。AI Draft・人間編集・承認者を区別して追跡可能。
