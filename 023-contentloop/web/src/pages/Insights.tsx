import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, Err, Loading, PLATFORM_LABEL, PlatformBadge, Tabs, fmtDate, useAction, useLoad } from '../ui';

const linkFor = (c: any) => (c.refType === 'source' ? `/sources/${c.refId}` : c.refType === 'idea' ? `/ideas/${c.refId}` : c.refType === 'campaign' ? `/campaigns/${c.refId}` : `/content/${c.refId}`);
const TYPE_JA: Record<string, string> = { source: 'Source', idea: 'Idea', content: 'Content', campaign: 'Campaign' };

export function LibraryPage() {
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<string[]>(['source', 'idea', 'content']);
  const [platform, setPlatform] = useState('');
  const [res, setRes] = useState<any>(null);
  const a = useAction();
  const run = async (query = q) => {
    const params = new URLSearchParams({ q: query, types: types.join(','), ...(platform ? { platform } : {}) });
    setRes(await a.run(() => api.get(`/search?${params}`)));
  };
  const examples = ['まだThreadsで使ってないAI開発ネタ', '過去に反応が良かった失敗談', 'ProofFlow関連の未使用Idea', 'チェックリスト'];
  return (
    <div className="page">
      <h1>コンテンツライブラリ</h1>
      <form className="row" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="自然な言葉で検索（全文 + 類似）" aria-label="検索" className="grow" />
        <button className="btn primary" disabled={a.busy}>検索</button>
      </form>
      <div className="row wrap small">
        {examples.map((x) => <button key={x} className="chip" onClick={() => { setQ(x); run(x); }}>{x}</button>)}
      </div>
      <div className="row wrap small">
        {['source', 'idea', 'content'].map((t) => <label key={t} className="check"><input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />{TYPE_JA[t]}</label>)}
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform"><option value="">Platform: すべて</option>{Object.entries(PLATFORM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div>
      <Err e={a.error} />
      {res && (
        <Card title={`${res.hits.length}件`}>
          {res.parsed && <p className="small muted">解釈: {[res.parsed.platform && `Platform=${PLATFORM_LABEL[res.parsed.platform]}`, res.parsed.unused && '未使用', res.parsed.highPerf && '反応が良い', res.parsed.angle && `Angle=${res.parsed.angle}`, res.parsed.terms.length && `語句=${res.parsed.terms.join(',')}`].filter(Boolean).join(' / ') || 'なし'}</p>}
          {res.hits.length ? (
            <ul className="list results">
              {res.hits.map((h: any) => (
                <li key={h.refType + h.refId}>
                  <span className="tag">{TYPE_JA[h.refType]}</span> <Link to={linkFor(h)}>{h.title}</Link>
                  <p className="small">{h.snippet}</p>
                  <p className="small muted">出典: <Link to={linkFor(h.citation)}>{h.citation.title}</Link>{h.citation.url && <> ・ <a href={h.citation.url} target="_blank" rel="noreferrer noopener">URL</a></>} ・ 一致: {h.matchedBy.join(', ')}{h.meta?.metrics ? ` ・ 指標: ${Object.entries(h.meta.metrics).map(([k, v]) => `${k} ${v}`).join(' ')}` : ''}</p>
                </li>
              ))}
            </ul>
          ) : <Empty>見つかりませんでした</Empty>}
        </Card>
      )}
    </div>
  );
}

export function StrategistPage() {
  const [q, setQ] = useState('');
  const [log, setLog] = useState<{ q: string; a: any }[]>([]);
  const a = useAction();
  const nav = useNavigate();
  const ask = async (question = q) => {
    const r = await a.run(() => api.post('/strategist', { question }));
    if (r) setLog((l) => [{ q: question, a: r }, ...l]);
    setQ('');
  };
  const act = async (s: any) => {
    if (s.action?.type === 'draft_for_platform') {
      const r = await a.run(() => api.post('/drafts', { ideaId: s.action.ideaId, platform: s.action.platform }));
      if (r) nav(`/content/${r.content.id}`);
    } else if (s.action?.type === 'recycle') {
      const r = await a.run(() => api.post(`/content/${s.action.contentId}/recycle`, { mode: s.action.mode, platform: s.action.platform }));
      if (r) nav(`/content/${r.content.id}`);
    }
  };
  const examples = ['今日Threadsに何か投稿したい', 'まだ使ってないIdeaは？', '使いすぎたTopicは？', 'この動画からThreads案5つ', '反応良かったTopicを別角度で', 'Campaignで足りない投稿は？'];
  return (
    <div className="page narrow">
      <h1>AI Content Strategist</h1>
      <p className="muted">ContentLoop内のデータ（素材・ネタ・投稿・反応）を根拠に答えます。実績や利用者の声を作ったり、成果を保証したりはしません。</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (q) ask(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例: 今日Threadsに何を投稿する？" className="grow" aria-label="質問" />
        <button className="btn primary" disabled={a.busy || !q}>聞く</button>
      </form>
      <div className="row wrap small">{examples.map((x) => <button key={x} className="chip" onClick={() => ask(x)}>{x}</button>)}</div>
      <Err e={a.error} />
      {log.map((l, i) => (
        <Card key={i} title={l.q}>
          <pre className="pre answer">{l.a.answer}</pre>
          {l.a.suggestions.length > 0 && (
            <ol className="list">
              {l.a.suggestions.map((s: any, k: number) => (
                <li key={k}>
                  <b>{s.label}</b> <span className="small muted">— {s.reason}</span>
                  <div className="small">根拠: <Link to={linkFor(s.citation)}>{s.citation.title}</Link></div>
                  {s.action && <button className="btn sm" onClick={() => act(s)}>{s.action.type === 'recycle' ? '別角度でDraft' : `${PLATFORM_LABEL[s.action.platform] ?? ''}のDraftを作る`}</button>}
                </li>
              ))}
            </ol>
          )}
          <p className="small muted">{l.a.caveats.join(' ')}（生成: {l.a.generatedBy}）</p>
        </Card>
      ))}
    </div>
  );
}

export function PerformancePage() {
  const [days, setDays] = useState(90);
  const [dim, setDim] = useState<'topic' | 'angle' | 'format' | 'platform' | 'length' | 'cta' | 'hook'>('topic');
  const { data: sum, error, loading } = useLoad(() => api.get(`/performance/summary?days=${days}`), [days]);
  const { data: fb } = useLoad(() => api.get(`/performance/feedback?dimension=${dim}&days=${days}`), [dim, days]);
  return (
    <div className="page">
      <div className="hero">
        <h1>効果分析</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="期間">{[30, 90, 180, 365].map((d) => <option key={d} value={d}>過去{d}日</option>)}</select>
      </div>
      {loading && <Loading />}
      <Err e={error} />
      {sum && (
        <>
          <p className="small muted">{sum.note}</p>
          <div className="grid3">
            {Object.entries(sum.byPlatform).map(([p, b]: any) => (
              <Card key={p} title={<PlatformBadge p={p} />}>
                <p>投稿 {b.posts}件（指標あり {b.withMetrics}件）</p>
                <dl className="kv">{Object.entries(b.totals).map(([k, v]: any) => <><dt key={k}>{k}</dt><dd key={k + 'v'}>{v.toLocaleString()}</dd></>)}</dl>
                <p className="small">median engagement: {b.medianEngagement != null ? `${(b.medianEngagement * 100).toFixed(1)}%` : '—'}</p>
                <p className="small muted">{b.definition}</p>
              </Card>
            ))}
            {!Object.keys(sum.byPlatform).length && <Empty>この期間の公開済み投稿はありません</Empty>}
          </div>
        </>
      )}
      <Card title="傾向（Feedback Loop）">
        <Tabs value={dim} onChange={setDim} items={[{ id: 'topic', label: 'Topic' }, { id: 'angle', label: 'Angle' }, { id: 'format', label: 'Format' }, { id: 'platform', label: 'Platform' }, { id: 'length', label: '長さ' }, { id: 'cta', label: 'CTA' }, { id: 'hook', label: 'Hook' }]} />
        {fb && (
          <>
            <p><b>{fb.insight}</b></p>
            <table className="table">
              <thead><tr><th>{dim}</th><th>件数 n</th><th>median engagement</th><th></th></tr></thead>
              <tbody>
                {fb.groups.map((g: any) => (
                  <tr key={g.key}>
                    <td>{g.key}</td><td>{g.n}</td><td>{(g.medianEngagement * 100).toFixed(2)}%</td>
                    <td><div className="bar"><span style={{ width: `${Math.min(100, (g.medianEngagement / Math.max(...fb.groups.map((x: any) => x.medianEngagement), 0.0001)) * 100)}%` }} /></div>{!g.enough && <span className="small muted">件数不足</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">期間: 過去{fb.periodDays}日（{fmtDate(fb.since)}〜）・公開 {fb.totalPublished}件中 指標あり {fb.withMetrics}件・分母: {fb.denominator}。{fb.caveat}</p>
          </>
        )}
      </Card>
    </div>
  );
}

export function RecyclingPage() {
  const { data, error, loading } = useLoad(() => api.get('/recycling'));
  const a = useAction();
  const nav = useNavigate();
  const go = async (id: string, mode: string) => {
    const r = await a.run(() => api.post(`/content/${id}/recycle`, { mode }));
    if (r) nav(`/content/${r.content.id}`);
  };
  return (
    <div className="page">
      <h1>過去の投稿を再利用</h1>
      <p className="muted">Reuse Rules（設定で変更可）に基づく候補です。再利用はDraftとして作成され、自動投稿はされません。</p>
      {loading && <Loading />}
      <Err e={error} />
      <Err e={a.error} />
      {data && (data.length ? (
        <div className="cards">
          {data.map((r: any) => (
            <div key={r.content.id} className="ccard">
              <div className="row"><PlatformBadge p={r.content.platform} /> <span className="tag">{r.content.recycleState}</span></div>
              <Link to={`/content/${r.content.id}`}>{r.content.body.slice(0, 120)}…</Link>
              <p className="small">{r.reason}</p>
              {!r.autoPublishAllowed && <p className="small warn-t">情報更新が必要なため自動投稿はできません</p>}
              <div className="row wrap">
                {r.suggestions.map((s: string) => <button key={s} className="btn sm" onClick={() => go(r.content.id, s)}>{({ new_angle: '別角度', different_platform: '別Platform', story: 'ストーリー', checklist: 'チェックリスト', updated_facts: '最新情報で更新', shorter: '短く', longer: '長く' } as any)[s] ?? s}</button>)}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty>現在の再利用候補はありません</Empty>)}
    </div>
  );
}
