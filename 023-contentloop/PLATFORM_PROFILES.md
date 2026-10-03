# PLATFORM_PROFILES

実装: `server/src/domain/platforms.ts`。**Platform Profile（書き方の仕様）は Connector Capability（API投稿可否）と別です。**
数値は 2026-10-02 時点の調査（SOURCE_NOTES.md）と一般的な運用値に基づく初期値で、`verifiedAt: null`（公式docsで最終確認していない）として扱います。**リリース前に各公式docsで再確認が必要です。**

| Platform | maxLength | 推奨長 | formats | hashtag上限 | link | 注意 |
|---|---|---|---|---|---|---|
| Threads | 500 | 80–300 | post, thread, quote | 1 | inline可 | 会話調 |
| X | 280（重み付け） | 60–200 | post, thread, quote | 2 | リンクで不利になる可能性 | 日本語は2カウント近似、URL=23 |
| LinkedIn | 3000 | 400–1300 | post, article, carousel | 3 | inline可 | 冒頭2行で要点 |
| Instagram | 2200 | 150–600 | carousel, caption, short_video | 5 | クリック不可 | Carousel枚数上限は要確認 |
| Facebook | 63206 | 100–500 | post | 2 | inline可 | Page投稿想定 |
| TikTok | 2200 | 50–150 | short_video, caption | 4 | クリック不可 | 縦動画必須 |
| YouTube Shorts | 5000 | 50–200 | short_video | 3 | inline可 | タイトル100文字（要確認） |
| YouTube Community | 1500 | 80–400 | post | 2 | inline可 | **公開APIなし → 手動投稿のみ** |
| Blog | 20000 | 1500–5000 | article | 0 | inline可 | 再構成・出典保持 |
| Newsletter | 15000 | 600–2500 | newsletter | 0 | inline可 | 件名+プレビュー |
| Generic | 5000 | 100–800 | post, quote, caption | 3 | inline可 | |

各Profileは `ctaStyle / mediaRequirements / notes` を持ち、Brand Guard の length/hashtag/link チェックに使われます。
