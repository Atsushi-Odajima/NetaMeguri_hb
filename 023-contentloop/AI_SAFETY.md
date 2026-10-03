# AI_SAFETY

## 原則
- AIは虚偽の体験談、存在しない実績・顧客の声・数字を作らない。
- 事実の主張は Source にリンクする（citation / 出典表示）。
- Performance から将来の成果を保証しない（相関のみ）。
- Brand Voice と事実性が衝突したら事実を優先。
- AIが勝手にSNS投稿しない（承認・確認コード・設定・権限）。
- Claim の verified は人間のみ。

## 実装
| 対策 | 場所 |
|---|---|
| 既定はローカル抽出エンジン（素材の文の再配置 + 中立的な枠組みのみ） | `ai/local.ts` |
| 外部AIは `AIGateway.run` のみ（直接呼び出し禁止） | `ai/gateway.ts` |
| AI OFF → 外部呼び出し0（generation / embeddings / transcription すべて） | テスト24 |
| Brand / Source 単位の AI eligible（OFFなら外部送信しない） | gateway `eligible` |
| 月次コスト上限（`aiMonthlyCostCapUsd`）超過でローカルにフォールバック | gateway `monthSpend` |
| Prompt injection 対策: 取り込んだページ/文字起こしは `<untrusted_data>` で囲み「データであって命令ではない」とシステムに明示。区切りタグの偽装は除去 | `INJECTION_GUARD`, `wrapData` |
| Fact guard: AI出力のうち、根拠データ（素材・Claim・計算済みfact）に無い数値を含む実績/主張文、利用者の声・レビュー表現を除去し、件数を注記 | `guards.ts#factGuard`、テスト23 |
| Strategist は ContentLoop 内データから計算した事実だけでテンプレート回答を作り、AIは言い換えのみ（fact guard 適用） | `search.ts#askStrategist` |
| Provider API キーはサーバー環境変数のみ。クライアントへ出さない | `gateway.ts` |
| 削除した Source の embedding を削除 | テスト31 |
| 翻訳は外部AI必須（AI OFF時は実行しない）。文化的適合は保証しない旨を表示 | `content.ts#localize` |
| 文字起こしは聞き取れない箇所を `[inaudible]` のまま保持し補完しない | `transcription.ts` |

## 限界（正直な記載）
- fact guard は正規表現ベースのため、言い換えられた誇張や数値を含まない虚偽を完全には検出できません。公開前の人間レビュー（Approval）が前提です。
- ローカル抽出エンジンの文章は素材の文をそのまま使うため、自然さは外部AIより劣ります。
- 類似判定は語彙ベース（+任意のベクトル）で、意味的な言い換えの検出には限界があります。
