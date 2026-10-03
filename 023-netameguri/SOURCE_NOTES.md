# ContentLoop SOURCE_NOTES（外部仕様・価格・ライセンス調査メモ）

確認日: 2026-10-02

> **免責 / Disclaimer**: 本メモは 2026-10-02 時点の調査記録であり、各プラットフォームの API 仕様・審査要件・レート制限・価格は頻繁に変更される。**リリース前・契約前に必ず各公式ページで再確認すること。** 法的判断（商標・ライセンス・利用規約適合性）は含まない。

## 調査方法と信頼度の凡例

調査環境のネットワーク制限で、多くの公式ドメイン（developers.facebook.com, docs.x.com, learn.microsoft.com, developers.google.com, developers.tiktok.com, developer.wordpress.org, openai.com, modelcontextprotocol.io, buttondown.com など）は **本文の直接取得（WebFetch）がブロック** された。そのため確認方法を以下で区別する。

| 記号 | 意味 |
|---|---|
| **[F]** | 公式ページ本文を直接取得して確認（Fetched） |
| **[S]** | 公式ドメインに限定した Web 検索結果の抜粋（snippet）で確認。本文全体は未読。**リリース前に本文で再確認必須** |
| **未確認 (unverified)** | 公式ソースで確認できなかった。推測で埋めていない |

[F] で確認できたもの: Anthropic 価格ページ、Cloudflare R2 価格（Cloudflare 公式 docs 検索ツール経由で本文取得）、MDN browser-compat-data（GitHub `mdn/browser-compat-data` commit `f2dd714`, 2026-10-02）。それ以外は基本的に [S]。

---

## 1. プラットフォーム別

### 1.1 Threads

| 項目 | 内容 |
|---|---|
| 公式 API | Threads API (Meta) — https://developers.facebook.com/documentation/threads/overview , https://developers.facebook.com/docs/threads/posts/ |
| 投稿 (Publish) | **yes** [S]。メディアコンテナ作成 → `POST /{threads-user-id}/threads_publish` の 2 段階。Meta アプリ作成・権限の App Review が必要（審査要件の詳細は未確認） |
| ネイティブ予約 | **ドキュメント上の予約エンドポイントは確認できず** [S]。Docs は「アプリ側で予約投稿を実装する場合もレート制限を守れ」という記述のみ → アプリ側スケジューラ前提 |
| 分析 | **yes** [S]。`threads_manage_insights` で profile / 個別 thread の insights。Profile 指標: `views`, `likes`, `replies`, `reposts`, `quotes`, follower count 等（過去7日集計の記述あり）。メディア単位の正確な metric 名一覧は **未確認**（docs/threads/insights 本文未取得） |
| 削除 | **yes** [S]。`threads_delete` 権限、100 deletions / 24h |
| OAuth scope（最小） | 投稿: `threads_basic`, `threads_content_publish` / 分析: `threads_basic`, `threads_manage_insights` / 削除: `threads_delete` [S] |
| レート制限 | 250 API-published posts / 24h moving window / profile（カルーセルは1件）。使用量は `GET /{threads-user-id}/threads_publishing_limit` [S]。返信は別枠との第三者記述ありだが公式未確認 |
| 商用条件・価格 | API 利用料の記載は **未確認**（Meta Platform Terms 適用と思われるが本文未確認） |
| 注意 | 投稿内容を作成者本人以外へ表示する用途には制約がある旨の記述あり（"display those posts within your app solely to the person who created it"）[S] → 設計時に要確認 |

### 1.2 X (Twitter)

| 項目 | 内容 |
|---|---|
| 公式 API | X API v2 — https://docs.x.com/x-api/introduction , Manage Posts: https://docs.x.com/x-api/posts/manage-tweets/introduction |
| 投稿 | **yes** `POST /2/tweets`（ユーザーコンテキスト）[S] |
| ネイティブ予約 | **X API v2 には無し**（`POST /2/tweets` は即時投稿）[S]。**Ads API** に `POST accounts/:account_id/scheduled_tweets`（最大1年先、分単位）あり — Ads API アクセスと広告アカウントが前提 [S] https://docs.x.com/x-ads-api/creatives/reference |
| 分析 | **yes** [S]。`public_metrics`（impression_count, like_count, retweet_count, reply_count, quote_count, bookmark_count）は任意トークン、`non_public_metrics` / `organic_metrics`（url_link_clicks, user_profile_clicks, engagements 等）は **自分の投稿のみ・ユーザーコンテキスト** https://docs.x.com/x-api/fundamentals/metrics |
| 削除 | `DELETE /2/tweets/:id`（Manage Posts）— 本文未取得のため詳細 **未確認** |
| OAuth scope | 投稿: `tweet.read`, `tweet.write`, `users.read`（+ refresh token 用 `offline.access`）[S] https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping |
| レート制限 | `POST /2/tweets`: 100 req / 15min per user, 10,000 / 24h per app [S] https://docs.x.com/x-api/fundamentals/rate-limits |
| 商用条件・価格 | **Pay-per-use（クレジット前払い）が標準**。Free/Basic/Pro の legacy パッケージは deprecate、legacy Basic は PPU へ移行と告知 [S]。2026-04-20 以降の価格（検索抜粋）: Post create **$0.015/件**、URL 含む Post **$0.20/件**、summoned reply $0.01、Owned Reads $0.001/resource [S] https://docs.x.com/x-api/getting-started/pricing , https://docs.x.com/changelog 。Enterprise は別契約 https://docs.x.com/enterprise-api/getting-started/pricing |
| 注意 | URL 付き投稿が高額（$0.20）→ ブログ/ニュースレターへの誘導リンクを含む運用ではコスト影響大。価格は頻繁に改定されており要再確認 |

### 1.3 LinkedIn

| 項目 | 内容 |
|---|---|
| 公式 API | Posts API（Community Management API）— https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api 、個人向け self-serve: Share on LinkedIn https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin |
| 投稿 | **limited/yes** [S]。会員本人: `w_member_social`。組織ページ: `w_organization_social`（ADMINISTRATOR / CONTENT_ADMIN / DIRECT_SPONSORED_CONTENT_POSTER ロール必須）。Community Management API は **申請・承認制**（Development tier → Standard tier）。`LinkedIn-Version: YYYYMM` ヘッダ必須 |
| ネイティブ予約 | **未確認**（docs に予約投稿の記述を確認できず）。`lifecycleState` は作成時 `PUBLISHED` のみ受付 [S] → DRAFT 作成も不可と読める |
| 分析 | **yes (要承認)** [S]。組織: `organizationalEntityShareStatistics`（impressionCount, clickCount, commentCount, engagement 等、直近12か月）https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics 。会員: `memberCreatorPostAnalytics`（IMPRESSION, MEMBERS_REACHED, RESHARE, REACTION, COMMENT, POST_SAVE, POST_SEND, LINK_CLICKS）scope `r_member_postAnalytics` https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics |
| 削除 | **yes** `DELETE /rest/posts/{urn}` → 204 [S] |
| OAuth scope | 投稿: `w_member_social` or `w_organization_social` / 分析: `r_organization_social`（組織）, `r_member_postAnalytics`（会員）[S] |
| レート制限 | 24h 単位（UTC 0時リセット）、application と member の2軸。標準値は非公開で Developer Portal で確認。CM API Development tier: 500 calls/app/24h, 100 calls/member/24h, BATCH_GET 不可 [S] https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits |
| 商用条件・価格 | API 利用料の記載は **未確認**。アクセスは審査制 |
| 注意 | 会員の分析 API の承認要件は **未確認**。Development tier は12か月以内に Standard へ移行する前提の記述あり [S] |

### 1.4 Instagram

| 項目 | 内容 |
|---|---|
| 公式 API | Instagram Platform（Instagram API with Instagram Login / with Facebook Login）— https://developers.facebook.com/docs/instagram-platform/content-publishing/ |
| 投稿 | **limited** [S]。**Professional（Business/Creator）アカウントのみ**。画像・動画・Reels・カルーセル（Stories 対応は本文で要確認）。コンテナ作成 → `POST /<IG_ID>/media_publish`。`instagram_content_publish` は App Review 必須 |
| ネイティブ予約 | **docs 上で確認できず（未確認）** → アプリ側スケジューラ前提 |
| 分析 | **yes** [S]。account / media insights（reach, views, likes, comments, saved, shares 等。`impressions` 系は `views` へ移行中の記述あり）。正確な metric 名・deprecation 日は本文で要確認 https://developers.facebook.com/docs/instagram-platform/insights/ |
| 削除 | **未確認** |
| OAuth scope | Instagram Login: `instagram_business_basic`, `instagram_business_content_publish`（分析は `instagram_business_manage_insights` — 名称は [S] 抜粋で未完全確認）/ Facebook Login: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`（+ `pages_show_list`, `business_management`）, 分析 `instagram_manage_insights` |
| レート制限 | 100 API-published posts / 24h moving（カルーセル1件）、`GET /<IG_ID>/content_publishing_limit` で確認。コンテナ作成 400 / 24h、コンテナは24hで失効 [S]。※検索抜粋に「50 posts/24h」の記述も混在 → **矛盾あり・本文で要確認** |
| 商用条件・価格 | API 利用料の記載は **未確認** |
| 注意 | 個人アカウントへは投稿不可。メディアは公開 URL から取得される方式（R2 等の公開 URL が必要）|

### 1.5 Facebook Pages

| 項目 | 内容 |
|---|---|
| 公式 API | Pages API / Graph API Page Feed — https://developers.facebook.com/docs/pages-api/ , https://developers.facebook.com/docs/graph-api/reference/page/feed/ |
| 投稿 | **yes**（Page access token 必須、個人タイムラインは不可）[S] |
| ネイティブ予約 | **yes** [S]。`published=false` + `scheduled_publish_time`（UNIX time）。範囲は docs 内で「10分〜75日」と「10分〜6か月」の両記述が抜粋に混在 → **本文で要確認** |
| 分析 | **yes** [S]。Page/Post insights（post_impressions → `views` へ置換、page fans 等は 2025-11-15 から deprecate、2026-06-15 までに追加 deprecate、reach → viewers 置換予定）https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/ |
| 削除 | **未確認**（本文未取得） |
| OAuth scope | 投稿: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` / 分析: `read_insights`（+ `pages_read_engagement`, `pages_show_list`）[S] |
| レート制限 | Graph API の BUC レート制限（具体値は本文未取得で **未確認**）https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ |
| 商用条件・価格 | API 利用料の記載は **未確認** |
| 注意 | Insights の metric は 2025–2026 に大幅入れ替え中。metric 名をハードコードせず設定化推奨 |

### 1.6 TikTok

| 項目 | 内容 |
|---|---|
| 公式 API | Content Posting API — https://developers.tiktok.com/doc/content-posting-api-reference-direct-post , Display API https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list |
| 投稿 | **limited** [S]。Direct Post（`video.publish`）と Upload to Inbox/Draft（`video.upload`、ユーザーがアプリ内で仕上げて投稿）。**未監査クライアントは SELF_ONLY（非公開）投稿のみ、24h で最大5ユーザー**。公開投稿には audit 必須 |
| ネイティブ予約 | **未確認**（docs で確認できず） |
| 分析 | **limited** [S]。`video.list` で自分の公開動画の like_count, view_count, share_count, comment_count。`user.info.stats` で follower/likes/video count。詳細アナリティクス（視聴維持率等）は **未確認** |
| 削除 | **未確認**（API での削除は確認できず） |
| OAuth scope | 投稿: `video.publish`（直接）/ `video.upload`（下書き）。分析: `video.list`, `user.info.stats`（+ `user.info.basic`）[S] https://developers.tiktok.com/docs/en/tiktok-api-scopes |
| レート制限 | Direct Post init: 6 req/min per user access_token。クリエイターごとの1日投稿上限あり（典型 ~15/日、全 API クライアント共有）。pending share は 24h で最大5 [S] https://developers.tiktok.com/docs/en/tiktok-api-v2-rate-limit |
| 商用条件・価格 | API 利用料の記載は **未確認**。Content Sharing Guidelines 遵守と audit が前提 https://developers.tiktok.com/docs/en/content-sharing-guidelines |
| 注意 | 投稿前に creator_info を取得し、プライバシー選択肢等の UI 表示要件がある（ガイドライン本文で要確認） |

### 1.7 YouTube（Shorts アップロード + コミュニティ投稿）

| 項目 | 内容 |
|---|---|
| 公式 API | YouTube Data API v3 — https://developers.google.com/youtube/v3/docs/videos/insert , YouTube Analytics API https://developers.google.com/youtube/analytics/metrics |
| 投稿（動画/Shorts） | **yes** `videos.insert` [S]。**Shorts 専用 API は無く**、縦型/正方形かつ3分以内の動画は Shorts に分類（2024-10-15 以降アップロード分）https://support.google.com/youtube/answer/15424877 。**2020-07-28 以降作成の未検証 API プロジェクトからのアップロードは private に制限**、解除には audit 必須 |
| ネイティブ予約 | **yes** `status.publishAt`（`privacyStatus=private` が前提）— 本文未取得のため条件は [S]/要確認 |
| コミュニティ投稿 | **UNAVAILABLE**。channel bulletin は廃止、`activities.insert` はサポート終了、`activities.list` も bulletin を返さない [S] https://developers.google.com/youtube/v3/docs/activities 。コミュニティ投稿を作成する公開 API は確認できず → **下書きエクスポート（手動投稿）のみ** |
| 分析 | **yes** [S]。YouTube Analytics API: views, estimatedMinutesWatched, averageViewDuration, likes, comments, subscribersGained 等 |
| 削除 | `videos.delete` 存在（本文未取得、**未確認**） |
| OAuth scope | 投稿: `https://www.googleapis.com/auth/youtube.upload` / 分析: `https://www.googleapis.com/auth/yt-analytics.readonly` [S] |
| レート制限（quota） | デフォルト: videos.insert 100 calls/day（専用 bucket、1 call = 1 unit）、search.list 100 calls/day、その他 10,000 units/day [S]。2025-12-04 に upload コストが ~1600 → ~100 units に変更、2026-06-01 から granular quota へ移行と revision history に記載 [S] https://developers.google.com/youtube/v3/revision_history |
| 商用条件・価格 | API 自体の料金記載は確認できず（quota 制。追加 quota は Quota and Compliance Audit 経由）https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits |
| 注意 | OAuth 同意画面の Google 検証（sensitive/restricted scope）が別途必要になる可能性 — **未確認** |

### 1.8 Blog（WordPress REST API）

| 項目 | 内容 |
|---|---|
| 公式 API | WP REST API Posts — https://developer.wordpress.org/rest-api/reference/posts/ |
| 投稿 | **yes** `POST /wp/v2/posts`。status: `publish`, `future`, `draft`, `pending`, `private` [S] |
| ネイティブ予約 | **yes** `status=future` + `date`/`date_gmt` [S] |
| 分析 | **コア API には無し（未確認）**。PV 等は Jetpack/GA 等の別サービス依存 |
| 削除 | **yes** `DELETE /wp/v2/posts/<id>`（デフォルトはゴミ箱、`force=true` で完全削除）[S] |
| 認証 | Application Passwords（WP 5.6+、Basic 認証）https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/ 。OAuth scope の概念はコアに無し（権限はユーザーロール依存） |
| レート制限 | コアに規定なし（ホスティング依存）— **未確認** |
| 価格 | WordPress 本体は OSS（GPL）。WordPress.com 等のホスティングでの API 制約は **未確認** |

### 1.9 Newsletter（例: Buttondown）

| 項目 | 内容 |
|---|---|
| 公式 API | Buttondown API — https://docs.buttondown.com/api-emails-create |
| 投稿（配信） | **yes** `POST https://api.buttondown.com/v1/emails`、`Authorization: Token <API_KEY>` [S] |
| ネイティブ予約 | **yes** `status: "scheduled"` + `publish_date`（未来日時）、`PATCH` で再スケジュール / `draft` へ戻す [S] https://docs.buttondown.com/scheduling-emails-via-the-api |
| 下書き | **yes** `status: "draft"` [S] https://docs.buttondown.com/drafting-emails-via-the-api |
| 分析 | **limited** email object に `analytics` フィールドあり（具体 metric は **未確認**）[S] |
| 削除 | **未確認** |
| 認証 | API キー（OAuth scope 概念なし。第三者アカウント連携用 OAuth の有無は **未確認**） |
| レート制限 | **未確認** |
| 価格 | API は全プラン（Free 含む）で利用可、と公式ブログ/機能ページ抜粋 [S]。Free: 100 subscribers, Basic $9/mo, Standard $29/mo, Professional $79/mo（抜粋、要再確認）https://buttondown.com/pricing |
| 代替: Mailchimp | Marketing API。API key または OAuth 2（他ユーザーアカウントは OAuth 推奨）。`POST /campaigns/{id}/actions/schedule` で予約、Reports で opens/clicks [S] https://mailchimp.com/developer/marketing/api/ 。レート制限・価格は **未確認** |

---

## 2. Connector capability 提案表

凡例: **✅ docs** = 公式 docs（[F] or [S]）で利用可と記載 / **△** = 条件付き（審査・アカウント種別等）/ **❓** = 未確認 / **✖** = 公式 API で不可（docs 記載）/ — = 対象外

| Platform | READ | ANALYTICS_READ | DRAFT_EXPORT | SCHEDULE (native) | PUBLISH | DELETE | 提案 Connector 構成 |
|---|---|---|---|---|---|---|---|
| Threads | ✅ docs | ✅ docs (`threads_manage_insights`) | ✅（自前生成） | ❓（docs で native 予約未確認 → アプリ側予約） | △ docs（App Review、250/24h） | ✅ docs（100/24h） | READ/ANALYTICS_READ/PUBLISH/DELETE + app-side SCHEDULE |
| X | ✅ docs | ✅ docs（non_public は自投稿のみ） | ✅ | ✖ v2（Ads API のみ △） | △ docs（従量課金 $0.015/件、URL付 $0.20） | ❓ | PUBLISH/ANALYTICS_READ（従量課金ガード必須）+ app-side SCHEDULE |
| LinkedIn | △ docs | △ docs（CM API 承認・r_member_postAnalytics） | ✅ | ❓ | △ docs（会員: w_member_social / 組織: CM API 承認） | ✅ docs | 初期は DRAFT_EXPORT + 会員 PUBLISH、組織は承認後 |
| Instagram | ✅ docs | ✅ docs | ✅ | ❓ | △ docs（Professional 限定・App Review、100/24h） | ❓ | PUBLISH/ANALYTICS_READ + app-side SCHEDULE |
| Facebook Pages | ✅ docs | ✅ docs（metric 入替中） | ✅ | ✅ docs（scheduled_publish_time） | △ docs（Page token・権限審査） | ❓ | PUBLISH/SCHEDULE/ANALYTICS_READ |
| TikTok | △ docs（video.list） | △ docs（基本カウントのみ） | ✅ docs（video.upload で下書き送付） | ❓ | △ docs（audit 前は SELF_ONLY・5ユーザー/24h） | ❓ | 初期は DRAFT_EXPORT（inbox upload）、audit 後 PUBLISH |
| YouTube 動画/Shorts | ✅ docs | ✅ docs（Analytics API） | ✅ | ✅ docs（publishAt, private 前提） | △ docs（未検証プロジェクトは private 制限、100 uploads/day） | ❓（videos.delete 未確認） | PUBLISH/SCHEDULE/ANALYTICS_READ（audit 必須） |
| YouTube コミュニティ投稿 | ✖（bulletin 廃止） | ✖ / ❓ | ✅（テキスト/画像の手動投稿用エクスポート） | ✖ | **UNAVAILABLE** | ✖ | DRAFT_EXPORT のみ |
| WordPress | ✅ docs | ❓（コア無し） | ✅ docs（status=draft） | ✅ docs（status=future） | ✅ docs | ✅ docs | READ/DRAFT_EXPORT/SCHEDULE/PUBLISH/DELETE |
| Buttondown | ✅ docs | △（analytics フィールド、詳細未確認） | ✅ docs（draft） | ✅ docs（scheduled） | ✅ docs | ❓ | DRAFT_EXPORT/SCHEDULE/PUBLISH |

---

## 3. AI プロバイダ価格

### 3.1 Anthropic Claude API [F]
Source: https://platform.claude.com/docs/en/about-claude/pricing （USD / 1M tokens）

| Model | Input | 5m cache write | 1h cache write | Cache hit | Output | Batch in/out |
|---|---|---|---|---|---|---|
| Claude Fable 5.1 | $10 | $12.50 | $20 | $0.25 | $50 | $5 / $25 |
| Claude Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 | $2 / $10 |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 | $2.50 / $12.50 |
| Claude Sonnet 5.5 | $2 | $2.50 | $4 | $0.20 | $10 | $1 / $5 |
| Claude Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 | $1 / $5 |
| Claude Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 | $1.50 / $7.50 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 | $0.50 / $2.50 |

補足 [F]: Batch API は 50% 割引。Claude 4.6 以降は 1M context を標準価格で提供。`inference_geo: "us"` は 1.1x。Claude 4.7 以降は新 tokenizer で同一テキストあたり約30%多くトークン化される旨の記載（コスト見積りに影響）。Web search は $10 / 1,000 searches。Mythos 系は招待制（Project Glasswing）。Sonnet 5 の $2/$10 は導入価格から標準価格化（9/1 の値上げは中止）。

### 3.2 OpenAI API [S]
Source: https://developers.openai.com/api/docs/pricing , 各 model ページ（例: https://developers.openai.com/api/docs/models/gpt-5.5 ）

| 用途 | Model | 価格 |
|---|---|---|
| テキスト | GPT-5.5 | Input $5.00 / cached $0.50 / Output $30.00 per 1M（272K 超入力は 2x input・1.5x output、Batch/Flex は半額、Priority 2.5x）|
| テキスト | GPT-5.4 | Input $2.50 / cached $0.25 / Output $15.00 per 1M |
| テキスト | GPT-5.4 mini | Input $0.75 / cached $0.075 / Output $4.50 per 1M |
| テキスト | GPT-5（旧世代） | Input $1.25 / Output $10.00 per 1M |
| Embeddings | text-embedding-3-small | $0.02 / 1M tokens |
| Embeddings | text-embedding-3-large | $0.13 / 1M tokens |
| 文字起こし | gpt-transcribe | ~$0.0045 / min |
| 文字起こし | gpt-4o-transcribe | ~$0.006 / min（$2.50 in / $10.00 out per 1M audio/text tokens） |
| 文字起こし | gpt-4o-mini-transcribe | ~$0.003 / min（$1.25 / $5.00 per 1M） |
| 文字起こし | gpt-realtime-whisper（live） | ~$0.017 / min |
| 文字起こし | whisper-1 | **未確認**（従来 $0.006/min とされるが今回公式抜粋で確認できず） |

注: GPT-5.6 Sol 等のモデルページも存在（価格 **未確認**）。データレジデンシーは +10%。

---

## 4. MCP / ChatGPT Apps / Claude Code

| 項目 | 内容 | Source |
|---|---|---|
| MCP 最新仕様 | **2026-07-28**（前版 2025-11-25）[S]。主な変更: initialize ハンドシェイク廃止で stateless 化（各リクエストの `_meta` に protocol version / capabilities）、`server/discover` 必須、`subscriptions/listen` 導入（HTTP GET endpoint と resources/subscribe を置換）、Tasks はコアから公式 extension へ | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| MCP 2025-11-25 | Tasks、OAuth Client ID Metadata Documents（SEP-991）、URL mode elicitation 等 [S] | https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/ |
| OpenAI Apps SDK | MCP ベース、preview、OSS。Developer mode で MCP apps を作成・テスト。full MCP（write 系含む）は Business / Enterprise / Edu で beta、Pro は read/fetch のみ、**web のみ（モバイル非対応）** [S] | https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt , https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk , https://developers.openai.com/api/docs/mcp |
| Claude Code MCP | `claude mcp add --transport http <name> <url>`（HTTP = streamable-http）、stdio（`-- <command>`）、`add-json`、scope user/project（project は `.mcp.json`）[S] | https://code.claude.com/docs/en/mcp |
| Claude API MCP connector | Messages API から remote MCP server へ接続する機能のドキュメントあり（詳細未読）[S] | https://docs.claude.com/en/docs/agents-and-tools/mcp-connector |

注: Apps SDK の公開・審査（ChatGPT ディレクトリ掲載）条件は **未確認**。

---

## 5. インフラ価格例

### 5.1 Cloudflare R2 [F]（Last updated Oct 1, 2026）
Source: https://developers.cloudflare.com/r2/pricing/

| | Standard | Infrequent Access |
|---|---|---|
| Storage | $0.015 / GB-month | $0.01 / GB-month |
| Class A ops | $4.50 / million | $9.00 / million |
| Class B ops | $0.36 / million | $0.90 / million |
| Data retrieval | None | $0.01 / GB |
| Egress | Free | Free |
| Free tier（Standard のみ） | 10 GB-month, Class A 1M/月, Class B 10M/月 | 対象外 |

### 5.2 AWS S3（us-east-1）[S]
Source: https://aws.amazon.com/s3/pricing/
- S3 Standard: $0.023 / GB-month（最初の 50 TB）
- PUT/COPY/POST/LIST: $0.005 / 1,000 req、GET: $0.0004 / 1,000 req
- インターネット向け転送: 月 100 GB まで無料（全サービス合算）、以降は従量（単価は **未確認**）

### 5.3 Managed Postgres
**Supabase** [S] https://supabase.com/pricing
- Free: DB 500 MB、shared CPU/500 MB RAM、egress 5 GB、file storage 1 GB、50,000 MAU、1週間非アクティブで pause、active project 2 つまで
- Pro: $25/月〜、8 GB disk/project、250 GB bandwidth、100K MAU、daily backup 7日保持、$10/月の compute credit（Micro 1台分）、spend cap デフォルト有効

**Neon** [S] https://neon.com/docs/introduction/plans
- Free: $0、100 projects、100 CU-hours/project/月、最大 2 CU、1 GB storage/project
- Launch: $0.106 / CU-hour、storage $0.35 / GB-month（最低料金なし）
- Scale: $0.222 / CU-hour、storage $0.35 / GB-month

---

## 6. FFmpeg ライセンス [S]
Source: https://www.ffmpeg.org/legal.html , https://ffmpeg.org/doxygen/4.4/md_LICENSE.html

- FFmpeg 本体は **LGPL v2.1 or later**。ただし任意の GPL 部品を有効化（`--enable-gpl`）すると **全体が GPL v2+**（libx264 等は GPL）。
- `--enable-nonfree` を付けたビルドは **再配布不可**（unredistributable）。
- LGPL 準拠チェックリスト（公式 legal.html 抜粋）: `--enable-gpl`/`--enable-nonfree` なしでビルド、動的リンク、FFmpeg ソース配布、Web/アプリ About に LGPL 表記、GPL ライブラリ（libx264 等）を使わない、など。
- FFmpeg は **商用・独自ライセンスでは提供されない**。
- ContentLoop への示唆: サーバー側実行（SaaS としてバイナリ非配布）の場合とクライアント配布（デスクトップ/ffmpeg.wasm 同梱）の場合で義務が異なる → **法務確認が必要**。H.264 エンコードに libx264 を使うと GPL、コーデック特許は別問題（未調査）。

---

## 7. 名称 / 商標調査（"ContentLoop" / "Content Loop"）

**結論は出さない。以下は Web 検索で見つかった既存利用例の記録のみ。商標データベース（USPTO / J-PlatPat / EUIPO / WIPO）での正式調査は未実施 — 人間・法務レビュー必須。**

| 発見物 | 概要（検索抜粋による） | URL |
|---|---|---|
| Contentloop（Crunchbase） | モバイルアプリ向けコンテンツ管理（"nimble content management for mobile apps"）、所在地 Bellevue, WA | https://www.crunchbase.com/organization/contentloop , https://dwimc8vzw90ri.cloudfront.net/ |
| Content Loop (@ContentLoop on X) | 「クライアントからコンテンツ・フィードバック・承認を集める」ツール、"made in Chicago"、contentloop.io とされる | https://x.com/contentloop |
| ContentLoop（GitHub: ErnestKostevich） | **AI コンテンツ再利用ツール**: 記事/ポッドキャスト/YouTube 台本から X thread, LinkedIn, IG caption, newsletter, Shorts 台本, carousel, Reddit の7形式を生成。Claude Sonnet 4.5、BYOK。**本製品と機能領域がほぼ同一** | https://github.com/ErnestKostevich/ContentLoop |
| TM-contentloop（GitHub: AliciaChen727） | Meta（FB Pages / Instagram / Threads）の分析ダッシュボード + AI 診断 + 承認付き投稿/予約。**SNS 運用領域で重複** | https://github.com/AliciaChen727/TM-contentloop |
| The Content Loop（beehiiv newsletter） | B2B SaaS のコンテンツマーケ newsletter | https://thecontentloop.beehiiv.com/ |
| 類似名 | Loops（loops.so, メール SaaS）等 "Loop" を含むマーケ系名称は多数 | https://loops.so/ |

→ 同名・同領域の既存プロダクト/リポジトリが複数存在。**名称変更の検討を含めた商標調査を推奨**（判断は法務）。

### 7.1 名称変更（2026-10-03、オーナー指示）
上記を受け、製品名を **NetaMeguri（ネタめぐり）** に変更。候補の Web 検索結果（商標DB調査ではない）:

| 候補 | 結果 | 採否 |
|---|---|---|
| "Loop" 系（Loopwise 等） | Loopo / Loopsify / The Content Loop など同領域の類似名多数 | 不採用 |
| Recurra | RecurPost（SNS再投稿ツール）・Recura と近い | 不採用 |
| Meguri | MEGURIWA OS（SNS投稿用画像ホスティング, GitHub）が存在 | 不採用 |
| ネタモリ / Netamori | 「ネタもと」（PRプラットフォーム）・「ネタもり」ブログと近い | 不採用 |
| **NetaMeguri / ネタめぐり** | 同名のサービス・アプリは見つからず | **採用** |

検索: "Netameguri" OR "ネタめぐり" OR "ネタメグリ"（2026-10-03）。**J-PlatPat / USPTO 等での商標調査は未実施 — 販売前に必須。**

---

## 8. PWA Web Share Target（iOS Safari vs Android Chrome）[F]
Source: MDN browser-compat-data `manifests/webapp/share_target.json`（commit f2dd714, 2026-10-02）, https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target

| Browser | `share_target` 対応 |
|---|---|
| Chrome Android | **76+ 対応** |
| Chrome (desktop) | 89+（BCD 記載。実効は ChromeOS / Windows 等のインストール済み PWA — OS 別条件は未確認） |
| Edge / Samsung Internet | Chrome mirror |
| Opera Android | 63+ |
| **Safari (macOS) / Safari iOS** | **非対応**（version_added: false, WebKit bug https://webkit.org/b/194593 ） |
| WebView iOS / WebView Android | 非対応 |
| Firefox / Firefox Android | 非対応（Android はパースのみで効果なし） |

- status: experimental, standards track。MDN は「Baseline ではない」と明記。
- web.dev: share_target は Android（WebAPK）と ChromeOS で、**PWA インストール後のみ** 有効 [S] https://web.dev/learn/pwa/os-integration/
- ContentLoop への示唆: iOS では共有シートから PWA へ直接渡せない → iOS はコピペ / URL 貼付 / ファイル選択 / ショートカット等の代替導線が必要。

---

## 9. 主な未確認事項（リリース前 TODO）
1. Threads / Instagram のメディア単位 insights の正確な metric 名（docs 本文で確認）
2. Instagram の publish 上限（100 vs 50 / 24h の記述矛盾）
3. Facebook `scheduled_publish_time` の上限（75日 vs 6か月の記述混在）
4. LinkedIn / Instagram / TikTok / Threads のネイティブ予約可否
5. X の削除エンドポイント価格、X 価格の最新値（頻繁に改定）
6. TikTok / LinkedIn / Meta の API 利用料・商用利用条件（Platform Terms 本文）
7. YouTube OAuth 同意画面の検証要件、`videos.delete`、publishAt の条件
8. Buttondown / Mailchimp のレート制限・analytics 詳細
9. whisper-1 の現行価格
10. 商標の正式調査（法務）
