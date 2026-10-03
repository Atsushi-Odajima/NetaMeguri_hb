import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { ANGLE_LABEL, Card, Empty, Err, Loading, PLATFORM_LABEL, PlatformBadge, Status, Tabs, fmtDate, useAction, useLoad, Notice } from '../ui';

const BUCKETS: [string, string][] = [['unused', '未使用'], ['usedOnce', '1回使用'], ['reusable', '再利用可能'], ['recentlyUsed', '最近使用'], ['overused', '使いすぎ'], ['needsUpdate', '要更新'], ['retired', '引退']];
const LEVEL_JA: Record<string, string> = { new: 'New', related: 'Related', similar: 'Similar', very_similar: 'Very Similar' };

export function SimilarityList({ items }: { items: any[] }) {
  if (!items?.length) return <p className="small ok-t">似ている過去のIdeaは見つかりませんでした（New）。</p>;
  return (
    <ul className="list">
      {items.map((s) => (
        <li key={s.ideaId} className={`sim lv-${s.level}`}>
          <span className="tag">{s.recentlyUsed ? 'Recently Used' : LEVEL_JA[s.level]}</span> {s.message}
          <div className="small muted"><Link to={`/ideas/${s.ideaId}`}>{s.coreIdea.slice(0, 60)}</Link>（類似度 {s.score}{s.semanticScore != null ? ` / ベクトル ${s.semanticScore}` : ''}）</div>
        </li>
      ))}
    </ul>
  );
}

export function IdeasPage() {
  const { data, error, loading, reload } = useLoad(() => api.get('/ideas-memory'));
  const [tab, setTab] = useState('unused');
  const [text, setText] = useState('');
  const [sim, setSim] = useState<any[] | null>(null);
  const a = useAction();
  if (loading && !data) return <Loading />;
  if (error) return <Err e={error} />;
  const list = data[tab] ?? [];
  return (
    <div className="page">
      <h1>ネタ（Idea）</h1>
      <p className="muted">IdeaはContent（投稿文）と分けて管理されます。同じネタの使いすぎを防ぎ、良いネタを再利用するための記録です。</p>
      <Card title="新しいネタ・重複チェック">
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="思いついたネタや投稿したい内容を入力" aria-label="ネタ" />
        <div className="row wrap">
          <button className="btn" disabled={!text || a.busy} onClick={async () => setSim((await a.run(() => api.post('/ideas/similar', { text }))) ?? null)}>過去のネタと比べる</button>
          <button className="btn primary" disabled={text.length < 3 || a.busy} onClick={async () => { const r = await a.run(() => api.post('/ideas', { coreIdea: text, origin: 'manual' })); if (r) { setSim(r.similar); setText(''); reload(); } }}>Ideaとして保存</button>
        </div>
        <Err e={a.error} />
        {sim && <SimilarityList items={sim} />}
        <p className="small muted">「似ている」は候補表示です。重複と断定したり、自動で削除・統合したりはしません。</p>
      </Card>
      <Tabs value={tab} onChange={setTab} items={BUCKETS.map(([id, l]) => ({ id, label: `${l} (${data[id]?.length ?? 0})` }))} />
      <Card>
        {list.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>ネタ</th><th>Topic</th><th>Angle</th><th>状態</th><th>使用</th><th>最終使用</th></tr></thead>
              <tbody>
                {list.map((i: any) => (
                  <tr key={i.id}>
                    <td><Link to={`/ideas/${i.id}`}>{i.coreIdea.slice(0, 70)}</Link>{i.evergreen && <span className="tag">Evergreen</span>}</td>
                    <td>{i.topic}</td><td>{ANGLE_LABEL[i.angle] ?? i.angle}</td><td><Status s={i.status} /></td><td>{i.useCount}</td><td className="small">{fmtDate(i.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>該当するIdeaはありません</Empty>}
      </Card>
    </div>
  );
}

export function IdeaDetail() {
  const { id } = useParams();
  const { data: i, error, loading, reload } = useLoad(() => api.get(`/ideas/${id}`), [id]);
  const [platform, setPlatform] = useState('threads');
  const [angle, setAngle] = useState('');
  const [sim, setSim] = useState<any[] | null>(null);
  const a = useAction();
  const nav = useNavigate();
  if (loading && !i) return <Loading />;
  if (error) return <Err e={error} />;
  const draft = async (ang?: string, plat?: string) => {
    const r = await a.run(() => api.post('/drafts', { ideaId: i.id, platform: plat ?? platform, angle: (ang ?? angle) || undefined }));
    if (r) nav(`/content/${r.content.id}`);
  };
  const check = async () => setSim((await a.run(() => api.post('/ideas/similar', { text: i.coreIdea, excludeIds: [i.id] }))) ?? null);
  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1 className="h-idea">{i.coreIdea}</h1>
          <p className="small muted">Topic: {i.topic}・Angle: {ANGLE_LABEL[i.angle] ?? i.angle}・<Status s={i.status} />・使用 {i.useCount}回・最終 {fmtDate(i.lastUsedAt)}</p>
        </div>
      </div>
      {i.status === 'needs_update' && <Notice kind="warn">このIdeaは「要更新」です。内容を更新するまで自動投稿はできません。</Notice>}
      <Card title="Platform別Draftを作る">
        <div className="row wrap">
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform">{Object.entries(PLATFORM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select value={angle} onChange={(e) => setAngle(e.target.value)} aria-label="Angle"><option value="">角度: そのまま</option>{Object.entries(ANGLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="btn" onClick={check} disabled={a.busy}>重複チェック</button>
          <button className="btn primary" onClick={() => draft()} disabled={a.busy}>Draftを作成</button>
        </div>
        {sim && (
          <div className="stack">
            <SimilarityList items={sim} />
            {sim.length > 0 && (
              <div className="row wrap choices">
                <button className="btn sm" onClick={() => draft()}>そのまま</button>
                <button className="btn sm" onClick={() => draft(i.angle === 'story' ? 'how_to' : 'story')}>別角度</button>
                <button className="btn sm" onClick={() => draft('update')}>最新情報を追加</button>
                <button className="btn sm" onClick={() => draft(undefined, platform === 'threads' ? 'linkedin' : 'threads')}>別Platform</button>
                <button className="btn sm" onClick={() => setSim(null)}>使わない</button>
              </div>
            )}
          </div>
        )}
        <Err e={a.error} />
      </Card>
      <div className="grid2">
        <Card title="使用履歴">
          {i.uses.length ? <ul className="list">{i.uses.map((u: any, k: number) => <li key={k}><PlatformBadge p={u.platform} /> {fmtDate(u.used_at)}</li>)}</ul> : <Empty>未使用</Empty>}
        </Card>
        <Card title="このIdeaのContent">
          {i.content.length ? <ul className="list">{i.content.map((c: any) => <li key={c.id}><Link to={`/content/${c.id}`}><PlatformBadge p={c.platform} /> {(c.title ?? c.body).slice(0, 40)}</Link> <Status s={c.status} /></li>)}</ul> : <Empty>なし</Empty>}
        </Card>
        <Card title="状態を変更">
          <div className="row wrap">
            {['reusable', 'retired', 'needs_update', 'new'].map((s) => (
              <button key={s} className="btn sm" disabled={a.busy} onClick={async () => { await a.run(() => api.post(`/ideas/${i.id}/status`, { status: s })); reload(); }}><Status s={s} /></button>
            ))}
            <button className="btn sm" onClick={async () => { await a.run(() => api.patch(`/ideas/${i.id}`, { evergreen: !i.evergreen })); reload(); }}>{i.evergreen ? 'Evergreen解除' : 'Evergreenにする'}</button>
          </div>
        </Card>
        <Card title="出典">
          <ul className="list">{i.sourceIds.map((s: string) => <li key={s}><Link to={`/sources/${s}`}>Source {s.slice(0, 12)}</Link></li>)}</ul>
          {!i.sourceIds.length && <Empty>手動/Import由来</Empty>}
        </Card>
      </div>
    </div>
  );
}
