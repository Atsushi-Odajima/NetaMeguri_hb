# RECYCLING

実装: `server/src/domain/performance.ts#recyclingCandidates / recycle / setRecycleState`

## 分類（recycle_state）
Evergreen / Update Needed / Seasonal / High Performer / Reusable / Do Not Reuse

## Reuse Rules（設定 → 再利用ルール。既定値）
| ルール | 既定 | 動作 |
|---|---|---|
| 同一Platformで警告 | 30日 | 同じIdeaを同じPlatformで30日以内に使うと警告（エディタのチェック） |
| High Performer の再利用 | 60日 | 公開60日後から候補（別角度を提案） |
| 再利用候補にするまで | 45日 | Evergreen / Reusable を候補化 |
| 最近使用 | 30日 | Recently Used 判定 |
| 使いすぎ | 4回 | Overused |
| Seasonal | 指定月 | 指定月のみ候補 |
| Needs Update | 常時 | **自動投稿禁止**（候補には出すが API 予約・実行時に拒否） |
| Do Not Reuse | - | 候補から除外・再構成不可 |

## 再構成モード
別角度（new_angle）/ 最新情報で更新（updated_facts）/ 別Platform（different_platform: 未指定なら LinkedIn↔Threads）/ 短く（X）/ 長く（ブログ）/ ストーリー / チェックリスト。
再構成は常に **Draft** として作成され（`parent_content_id` で元投稿に紐づけ）、自動投稿されません。候補一覧は1回300件まで（新しい順）。
