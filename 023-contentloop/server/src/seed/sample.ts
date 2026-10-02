// Sample Workspace: fictional brand "Sample Build Lab". All people, products and numbers are fictional demo data.
import type { App, Ctx } from '../domain/context.js';
import { createUser, createWorkspace, ctxFor } from '../domain/workspace.js';
import { createBrand } from '../domain/brand.js';
import { importSource } from '../domain/sources.js';
import { extractIdeas, createIdea } from '../domain/ideas.js';
import { createPack, approve, requestReview, draftForPlatform } from '../domain/content.js';
import { markPublished } from '../domain/publish.js';
import { recordSnapshot, setRecycleState } from '../domain/performance.js';
import { createCampaign, draftSequence } from '../domain/campaigns.js';
import { createClaim, verifyClaim } from '../domain/claims.js';
import { setIdeaStatus } from '../domain/ideas.js';

const VIDEO_LINES = [
  'こんにちは、Sample Build Labです。今日は個人開発でAIコーディングを使ったときの失敗談を話します。',
  '最初にやってしまった失敗は、仕様を決めないままAIにコードを書かせ始めたことです。',
  'AIは指示が曖昧だと、それらしいけれど目的とずれたコードを大量に出してきます。',
  '結果として、動くけれど誰も使わない機能が三つもできてしまいました。',
  'そこで、実装前に一枚のPLANを書くことにしました。',
  'PLANには、誰のどんな困りごとを解決するのかと、完成条件だけを書きます。',
  '完成条件を書くと、AIに渡す指示が具体的になり、手戻りが大きく減りました。',
  '二つ目の失敗は、テストを後回しにしたことです。',
  'AIが書いたコードは一見正しく見えますが、境界値で壊れることがよくあります。',
  '特に日付やタイムゾーンの処理は、テストなしで信じてはいけません。',
  '今はAIに実装を頼む前に、まずテストケースを一緒に書いてもらっています。',
  '三つ目の失敗は、リリース前のチェックリストを持っていなかったことです。',
  'リリース当日にアイコンが表示されない、利用規約のリンクが切れている、といった小さな問題が次々に見つかりました。',
  'そこでリリースチェックリストを作りました。',
  'チェックリストには、表示確認、課金確認、バックアップ確認、問い合わせ導線の確認を入れています。',
  'チェックリストは毎回のリリースで見直して、漏れたものを追加していきます。',
  'AIコーディングで一番大事なのは、AIに任せる範囲と人間が判断する範囲を分けることだと思います。',
  '設計の判断と、ユーザーに何を約束するかは、人間が決めるべきです。',
  '[inaudible]',
  '逆に、定型的なコードやテストデータの作成はAIがとても得意です。',
  'もう一つのコツは、AIの出力を小さな単位でレビューすることです。',
  '一度に大きな変更をもらうと、レビューが追いつかず、問題を見逃します。',
  '小さく作って、小さく確認して、小さく直す。これが個人開発では一番速いです。',
  'ProofFlowの開発でもこのやり方に切り替えてから、リリースまでの期間が短くなりました。',
  '最後に、失敗を記録しておくことをおすすめします。',
  '失敗のメモは、次のプロジェクトのチェックリストになります。',
  'そして、そのメモはそのまま発信のネタにもなります。',
  '今日の話が、AIで個人開発をする方の参考になればうれしいです。',
];

function videoTranscript(): string {
  // 30-minute video: spread lines over ~1800s
  const step = Math.floor(1800 / VIDEO_LINES.length);
  return VIDEO_LINES.map((l, i) => {
    const a = i * step;
    const z = a + step - 1;
    const ts = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
    return `${i + 1}\n${ts(a)} --> ${ts(z)}\n${l}`;
  }).join('\n\n');
}

const BLOG = `リリースチェックリストを作ったら、個人開発のリリースが怖くなくなった話

個人開発のリリースは、毎回なにかしら忘れ物があります。
以前はリリース当日に、ストアの説明文の誤字や、問い合わせフォームの送信先の設定漏れに気づくことがよくありました。
そこで、リリースのたびに確認する項目をチェックリストにまとめました。
チェックリストの一つ目は表示確認です。主要な画面をスマホとPCで実際に開いて確認します。
二つ目は課金確認です。テスト環境で購入から解約までの流れを一度通します。
三つ目はバックアップ確認です。バックアップから空の環境へ復元できるかを確認します。
四つ目は問い合わせ導線の確認です。フォームからメールが届くかを実際に送って確かめます。
チェックリストは完成させるものではなく、育てるものです。
リリースのたびに、漏れていた項目を追加していくと、少しずつ強いリストになります。
AIにチェックリストの叩き台を作ってもらうのも便利ですが、最終的な判断は自分で行います。`;

const PRODUCT = `ProofFlow 製品ページ（架空）

ProofFlowは、個人開発者のためのリリース前チェックツールです。
リリースチェックリストをテンプレートから作成し、チームで進捗を共有できます。
料金は月額980円です。
14日間の無料トライアルがあります。
主な機能は、チェックリストのテンプレート、リリース履歴、通知です。
ProofFlowは、失敗の記録を次のリリースのチェック項目に変える仕組みを大切にしています。`;

const PODCAST = `[00:00] Sample Build Lab ラジオ、今回はAIと一緒に開発するときのレビューの話です。
[00:40] AIの出力は小さな単位でレビューするのが基本です。
[01:30] 大きな変更をまとめて受け取ると、どこが変わったのか追えなくなります。
[02:20] レビューのときは、まずテストが通るか、次に読みやすいかを見ます。
[03:10] それから、ユーザーに見える文言や約束が正しいかを人間が必ず確認します。
[04:00] AIは事実確認が苦手なこともあるので、数字や価格は元の資料と照らし合わせます。
[05:00] レビューのルールを決めておくと、AIを使っても品質が安定します。`;

export interface SampleResult { userId: string; workspaceId: string; ctx: Ctx; ids: Record<string, string> }

export async function seedSample(app: App, opts: { email?: string; password?: string; name?: string } = {}): Promise<SampleResult> {
  const now = app.clock.now();
  const email = opts.email ?? 'demo@sample-build-lab.invalid';
  const existing = app.db.get('SELECT id FROM users WHERE email = ?', email);
  const userId = existing?.id ?? createUser(app.db, email, opts.name ?? 'Demo Owner', opts.password ?? 'demo-password-123', now).id;
  const workspaceId = createWorkspace(app.db, userId, 'Sample Build Lab（サンプル）', now, { isSample: true, kind: 'small_team' });
  const ctx = ctxFor(app, userId, workspaceId);
  const ids: Record<string, string> = {};
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();

  const brand = createBrand(ctx, {
    name: 'Sample Build Lab', description: 'AIを使った個人開発の実践と学びを発信する架空のブランド', audience: '個人開発者・小規模チーム',
    positioning: '失敗も含めた実践ベースの発信', voiceSummary: '落ち着いた丁寧語。具体的な手順と失敗からの学びを短く伝える。誇張しない。',
    tone: '落ち着いた・丁寧', language: 'ja', preferredTerms: ['個人開発', 'チェックリスト'], bannedTerms: ['絶対儲かる', '誰でも簡単に', '神アプリ'],
    ctaStyle: '問いかけで会話を促す', bannedCtas: ['今すぐ購入'], emojiPolicy: 'few', maxEmoji: 1, hashtagsPolicy: 'minimal',
    examplesGood: ['リリース前に確認することを3つに絞りました。表示・課金・バックアップです。'], examplesBad: ['これで絶対儲かる！神アプリの作り方🔥🔥🔥'],
  });
  ids.brand = brand.id;
  ctx.app.db.update('brands', brand.id, workspaceId, { voice_status: 'confirmed' });

  const video = await importSource(ctx, { type: 'video', title: 'AIコーディング個人開発 失敗談3つ（30分）', url: 'https://example.com/videos/ai-coding-failures', transcript: videoTranscript(), author: 'Sample Build Lab', publishedAt: daysAgo(40), rightsStatus: 'owned', brandId: brand.id, durationSec: 1800 });
  const blog = await importSource(ctx, { type: 'blog', title: 'リリースチェックリストを作ったら怖くなくなった話', url: 'https://example.com/blog/release-checklist', text: BLOG, author: 'Sample Build Lab', publishedAt: daysAgo(120), rightsStatus: 'owned', brandId: brand.id, evergreen: true, evergreenCategory: 'How-to' });
  const product = await importSource(ctx, { type: 'product_page', title: 'ProofFlow 製品ページ', url: 'https://example.com/proofflow', text: PRODUCT, rightsStatus: 'owned', brandId: brand.id, evergreen: true, evergreenCategory: 'Product説明', publishedAt: daysAgo(200) });
  const podcast = await importSource(ctx, { type: 'podcast', title: 'Sample Build Lab ラジオ #12 AIレビュー', transcript: PODCAST, author: 'Sample Build Lab', publishedAt: daysAgo(20), rightsStatus: 'owned', brandId: brand.id });
  Object.assign(ids, { video: video.id, blog: blog.id, product: product.id, podcast: podcast.id });

  const vIdeas = await extractIdeas(ctx, video.id, { max: 8 });
  const bIdeas = await extractIdeas(ctx, blog.id, { max: 5 });
  const pIdeas = await extractIdeas(ctx, product.id, { max: 4 });
  await extractIdeas(ctx, podcast.id, { max: 4 });

  const claim = createClaim(ctx, { key: 'proofflow.price', label: 'ProofFlow 月額料金', value: '月額980円', source: 'https://example.com/proofflow', validFrom: daysAgo(200), brandId: brand.id });
  verifyClaim(ctx, claim.id);
  createClaim(ctx, { key: 'proofflow.trial', label: 'ProofFlow 無料トライアル', value: '14日間の無料トライアル', source: 'https://example.com/proofflow', brandId: brand.id });
  ids.claimPrice = claim.id;

  // Past usage: same failure-story idea used on Threads (18 days ago) and X (45 days ago)
  const failIdea = vIdeas.find((x) => x.idea.angle === 'failure_story')?.idea ?? vIdeas[0].idea;
  ids.failIdea = failIdea.id;
  const pastThreads = await draftForPlatform(ctx, { ideaId: failIdea.id, platform: 'threads' });
  requestReview(ctx, pastThreads.content.id);
  await approve(ctx, pastThreads.content.id);
  markPublished(ctx, pastThreads.content.id, { url: 'https://www.threads.net/@sample/post/demo1', publishedAt: daysAgo(18) });
  recordSnapshot(ctx, { contentId: pastThreads.content.id, window: '7d', metrics: { views: 4200, likes: 180, comments: 22, shares: 15 }, source: 'manual', capturedAt: daysAgo(11) });
  ids.pastThreads = pastThreads.content.id;

  const pastX = await draftForPlatform(ctx, { ideaId: failIdea.id, platform: 'x' });
  requestReview(ctx, pastX.content.id);
  await approve(ctx, pastX.content.id);
  markPublished(ctx, pastX.content.id, { publishedAt: daysAgo(45) });
  recordSnapshot(ctx, { contentId: pastX.content.id, window: '7d', metrics: { impressions: 3100, likes: 40, comments: 3, shares: 6 }, source: 'manual', capturedAt: daysAgo(38) });

  // High performer from the blog (published 70 days ago) + some peers
  const checklistIdea = bIdeas.find((x) => x.idea.angle === 'checklist')?.idea ?? bIdeas[0].idea;
  const hp = await draftForPlatform(ctx, { ideaId: checklistIdea.id, platform: 'threads' });
  requestReview(ctx, hp.content.id);
  await approve(ctx, hp.content.id);
  markPublished(ctx, hp.content.id, { publishedAt: daysAgo(70) });
  ids.highPerformer = hp.content.id;
  const peers: string[] = [];
  for (const [k, ii] of [...vIdeas.slice(1, 4), ...bIdeas.slice(1, 3)].entries()) {
    const d = await draftForPlatform(ctx, { ideaId: ii.idea.id, platform: 'threads', variant: 1 });
    requestReview(ctx, d.content.id);
    await approve(ctx, d.content.id);
    markPublished(ctx, d.content.id, { publishedAt: daysAgo(60 + k * 3) });
    recordSnapshot(ctx, { contentId: d.content.id, window: '7d', metrics: { views: 2000 + k * 150, likes: 30 + k * 3, comments: 2 + k, shares: 1 }, source: 'manual', capturedAt: daysAgo(53 + k * 3) });
    peers.push(d.content.id);
  }
  recordSnapshot(ctx, { contentId: hp.content.id, window: '7d', metrics: { views: 5200, likes: 410, comments: 55, shares: 48, saves: 90 }, source: 'manual', capturedAt: daysAgo(63) });

  // Needs Update: product-price idea
  const priceIdea = pIdeas.find((x) => /980円|料金/.test(x.idea.coreIdea))?.idea ?? (await createIdea(ctx, { coreIdea: 'ProofFlowの料金は月額980円です。14日間の無料トライアルがあります。', angle: 'data', topic: 'ProofFlow', sourceIds: [product.id], brandId: brand.id, evergreen: true, evergreenCategory: 'Product説明', origin: 'source' })).idea;
  setIdeaStatus(ctx, priceIdea.id, 'needs_update', 'サンプル: 価格改定予定');
  ids.needsUpdateIdea = priceIdea.id;
  // Manual evergreen idea
  const ev = await createIdea(ctx, { coreIdea: 'Sample Build Labを始めた理由は、失敗を共有できる場所を作りたかったから。', angle: 'story', topic: 'Founder story', evergreen: true, evergreenCategory: 'Founder story' });
  ids.founderIdea = ev.idea.id;

  // Campaign: New App Launch
  const start = new Date(now.getTime() + 3 * 86400_000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 24 * 86400_000).toISOString().slice(0, 10);
  const camp = createCampaign(ctx, { name: 'New App Launch: ProofFlow 2.0', objective: 'ProofFlow 2.0のリリース告知と事前登録の獲得', startDate: start, endDate: end, product: 'ProofFlow', audience: '個人開発者', keyMessages: ['リリース前の不安をチェックリストで減らす', '失敗の記録を次のリリースに活かす', '14日間の無料トライアル'], sourceIds: [video.id, blog.id, product.id], channels: ['threads', 'x', 'linkedin', 'instagram'], status: 'active', brandId: brand.id });
  draftSequence(ctx, camp.id);
  ids.campaign = camp.id;

  // Content Pack demo from the video (smaller counts for the sample)
  const pack = await createPack(ctx, { sourceIds: [video.id], brandId: brand.id, counts: { short_video: 3, threads: 4, x: 4, linkedin: 2, instagram_carousel: 1, blog: 1, newsletter: 1, quote: 3 } });
  ids.pack = pack.id;

  // Mark one recycling candidate state explicitly
  setRecycleState(ctx, hp.content.id, 'high_performer');
  return { userId, workspaceId, ctx, ids };
}
