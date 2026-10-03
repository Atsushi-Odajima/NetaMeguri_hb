# BRAND_VOICE — Brand Profile / Voice / Guard

実装: `server/src/domain/brand.ts`, `server/src/domain/guards.ts`, `server/src/ai/local.ts#draftBrandVoice`

## Brand Profile 項目
name, description, audience, positioning, voiceSummary, tone, language, preferredTerms, bannedTerms, ctaStyle, bannedCtas, emojiPolicy(none/few/free), maxEmoji, sentenceStyle, hashtagsPolicy(none/minimal/standard), examplesGood/Bad, aiEligible, localeProfiles（言語別 tone/notes/bannedTerms）

## Voice Draft → 人間確認
1. 過去投稿・記事・商品説明などのサンプルを貼り付け（`POST /brands/:id/voice-draft`）。
2. ヒューリスティック解析: tone（感嘆符/疑問符の比率）、formality（です/ます vs だ/である）、平均文長、humor、絵文字/投稿、CTA例、頻出語。
3. 外部AIが有効かつ Brand が AI対象なら要約文を追加（`AIGateway` 経由、fact guard 適用）。
4. `voice_status=draft` で保存。人間が `voice-confirm` で確定するまで「確定Voice」としては扱わない。
5. 画面・Draftに「本人の文体の完全再現は保証しません」と明記。

## Brand Guard（個別チェック、単一スコアなし）
| check | severity | 内容 |
|---|---|---|
| banned_term | block | 禁止表現（NFKC正規化・大文字小文字無視）。locale profile の禁止語も加算 |
| banned_cta | block | 禁止CTA |
| emoji | warn | 方針（none=0 / few=maxEmoji / free=無制限）超過 |
| length | block / info | Platform上限超過は block、推奨の1.5倍超は info（X は全角2カウントの近似） |
| hashtags | warn | Platform方針の上限超過 |
| link | info | Instagram/TikTok 等で本文URLがクリック不可 |
| tone | info | 落ち着いたtoneで感嘆符3個以上、です/ます・だ/である混在 |
| unverified_claim | warn | 数値・価格・ランキング等が Claim Registry に登録された値と一致しない |

block がある場合は承認・API予約ができません。Brand Voice と事実性が衝突した場合は事実を優先します（AI_SAFETY.md）。
