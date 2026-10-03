# IDEA_FINGERPRINT — Idea / 類似判定 / Freshness

実装: `server/src/domain/fingerprint.ts`, `ideas.ts`, `guards.ts#freshnessCheck`

## Idea
Content（投稿文）とは別の「ネタ」単位。`coreIdea / angle / topic / sourceIds / status / firstUsedAt / lastUsedAt / useCount / fingerprint / embeddingRef`。
status: `new / used / reusable / overused / retired / needs_update`（retired と needs_update は手動・Claim更新でのみ設定、他は使用履歴から再計算）。

Idea Memory（ダッシュボード/ネタ画面）: 未使用・1回使用・再利用可能・最近使用・使いすぎ・要更新・引退。High-performing Topics は Feedback Loop（PERFORMANCE_LOOP.md）から取得し Strategist が利用。

## Fingerprint v1
- 正規化（NFKC, 小文字, URL/ハッシュタグ/記号除去）後の文字trigramの上位160件を FNV-1a でハッシュ化した頻度表 + キーワード（英単語/カタカナ語/漢字語）最大40件。
- 類似度 = `0.6 × cosine(trigram) + 0.4 × sqrt(jaccard(keywords))`
- 任意で Semantic: ベクトルcosine（既定はローカル hashing vector = 語彙近似。OpenAI embeddings は設定時）。`score = max(lexical, 0.9 × semantic)`。

| Level | しきい値 | 表示 |
|---|---|---|
| New | < 0.22 | 候補なし |
| Related | ≥ 0.22 | 関連しています |
| Similar | ≥ 0.40 | 似ています |
| Very Similar | ≥ 0.58 | 非常に近いです |
| Recently Used | Similar以上 かつ 最終使用が `recentlyUsedDays`（既定30日）以内 | 例: 「この内容は18日前にThreadsで使用したIdeaと非常に近いです。」 |

**「似ている＝重複」と断定しません。** 自動削除・自動統合は行わず、ユーザーが選びます: そのまま / 別角度 / 最新情報追加 / 別Platform / 使わない（UI: Idea詳細「重複チェック」、エディタ「チェック」タブ）。

## スケール
- Idea ≤ 5,000: 全件と比較。
- それ以上: FTS5(trigram) でキーワード OR 検索して最大3,000件に絞り込み → 語彙スコア ≥0.12 の上位400件だけベクトルを読み込み比較。
- 計測値は TEST_REPORT.md。

## Freshness
価格・仕様・ランキング・「現在/最新」・統計・日付・イベントを含む文を、元素材の日付から30日以上経過していれば警告します。AIは古い数字を最新として断定しません（警告を出し、人間確認を求める）。Claim Registry（古い値の使用）とは別のチェックです。
