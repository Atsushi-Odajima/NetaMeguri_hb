import { Link, useNavigate } from 'react-router-dom';
import { api, request } from '../api';
import { Card, Empty, Err, Loading, PlatformBadge, Status, fmtDate, useLoad, useAction, Notice } from '../ui';
import { useSession } from '../App';

export function Dashboard() {
  const { data, error, loading } = useLoad(() => api.get('/dashboard'));
  const { session } = useSession();
  const nav = useNavigate();
  const sample = useAction();
  if (loading && !data) return <Loading />;
  if (error) return <Err e={error} />;
  const d = data!;
  const c = d.counts;
  const tasks = [
    { label: 'レビュー待ち', n: c.needsReview, to: '/review' },
    { label: '承認済み（未予約）', n: c.approved, to: '/content?status=approved' },
    { label: '予約済み', n: c.scheduled, to: '/calendar' },
    { label: '失敗した投稿', n: c.failed, to: '/content?status=failed' },
    { label: '再利用候補', n: d.recycling, to: '/recycling' },
    { label: '未整理のInbox', n: c.inbox, to: '/inbox' },
  ];
  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1>今日のタスク</h1>
          <p className="muted">素材を入れる → 投稿案 → SNS別に変換 → 使ったネタを覚える → 反応を見る → 良いネタを再利用</p>
        </div>
        <div className="row wrap">
          <button className="btn primary" onClick={() => nav('/sources/new')}>＋ 素材から作る</button>
          <button className="btn" onClick={() => nav('/strategist')}>今日なにを投稿する？</button>
        </div>
      </div>
      {!d.ai.externalCallsActive && <Notice kind="info">AI: {d.ai.aiEnabled ? 'ローカル抽出エンジン（外部AIへ送信しません）' : 'OFF（外部AIへ送信しません）'}。外部AIは設定から有効化できます。</Notice>}
      {c.sources === 0 && (
        <Card title="はじめに">
          <p>まだ素材がありません。動画の文字起こし、ブログ記事、商品ページなどを1つ登録すると、SNS別の投稿案をまとめて作れます。</p>
          <div className="row wrap">
            <button className="btn primary" onClick={() => nav('/sources/new')}>最初の素材を登録</button>
            <button className="btn" disabled={sample.busy} onClick={async () => { const r: any = await sample.run(() => request('POST', '/api/auth/sample-workspace', {})); if (r?.workspaceId) location.href = '/'; }}>サンプルWorkspaceを見る</button>
          </div>
          <Err e={sample.error} />
          <p className="small muted">サンプルは架空ブランド「Sample Build Lab」のデータで、本番データとは分離されます。{session.workspaces.length > 1 ? '左下のWorkspace切替から選べます。' : ''}</p>
        </Card>
      )}
      <div className="tiles">
        {tasks.map((t) => (
          <Link key={t.label} to={t.to} className="tile">
            <span className="tile-n">{t.n}</span>
            <span className="tile-l">{t.label}</span>
          </Link>
        ))}
      </div>
      <div className="grid2">
        <Card title="レビュー待ち" actions={<Link to="/review">すべて</Link>}>
          {d.reviewQueue.length ? (
            <ul className="list">
              {d.reviewQueue.map((x: any) => (
                <li key={x.id}>
                  <Link to={`/content/${x.id}`}><PlatformBadge p={x.platform} /> {(x.title ?? x.body).slice(0, 50)}</Link>
                </li>
              ))}
            </ul>
          ) : <Empty>レビュー待ちはありません</Empty>}
        </Card>
        <Card title="予約済み" actions={<Link to="/calendar">カレンダー</Link>}>
          {d.upcoming.length ? (
            <ul className="list">
              {d.upcoming.map((x: any) => (
                <li key={x.id}>
                  <Link to={`/content/${x.id}`}><span className="small">{fmtDate(x.scheduledAt)}</span> <PlatformBadge p={x.platform} /> {(x.title ?? x.body).slice(0, 40)}</Link>
                </li>
              ))}
            </ul>
          ) : <Empty>予約はありません</Empty>}
        </Card>
        <Card title="ネタの状態（Idea Memory）" actions={<Link to="/ideas">ネタ一覧</Link>}>
          <dl className="kv">
            <dt>未使用</dt><dd>{d.memory.unused}</dd>
            <dt>1回使用</dt><dd>{d.memory.usedOnce}</dd>
            <dt>再利用可能</dt><dd>{d.memory.reusable}</dd>
            <dt>最近使用</dt><dd>{d.memory.recentlyUsed}</dd>
            <dt>使いすぎ</dt><dd>{d.memory.overused}</dd>
            <dt>要更新</dt><dd>{d.memory.needsUpdate}</dd>
          </dl>
        </Card>
        <Card title="Content Pack">
          {d.packs.length ? (
            <ul className="list">
              {d.packs.map((p: any) => (
                <li key={p.id}><Link to={`/packs/${p.id}`}>Pack {fmtDate(p.createdAt)} — {p.itemCount}件</Link></li>
              ))}
            </ul>
          ) : <Empty>まだPackはありません</Empty>}
        </Card>
        <Card title="お知らせ">
          {d.notifications.length ? (
            <ul className="list">
              {d.notifications.map((n: any) => <li key={n.id} className={n.read_at ? 'muted' : ''}>{n.message} <span className="small muted">{fmtDate(n.created_at)}</span></li>)}
            </ul>
          ) : <Empty>お知らせはありません</Empty>}
        </Card>
        <Card title="数字">
          <dl className="kv">
            <dt>Source</dt><dd>{c.sources}</dd>
            <dt>Idea</dt><dd>{c.ideas}</dd>
            <dt>Draft</dt><dd>{c.drafts}</dd>
            <dt>公開済み</dt><dd>{c.published}</dd>
          </dl>
          <p className="small muted">タイムゾーン: {d.timezone}</p>
        </Card>
      </div>
      <p className="small muted">状態: <Status s="draft" /> → <Status s="needs_review" /> → <Status s="approved" /> → <Status s="scheduled" /> → <Status s="published" /></p>
    </div>
  );
}
