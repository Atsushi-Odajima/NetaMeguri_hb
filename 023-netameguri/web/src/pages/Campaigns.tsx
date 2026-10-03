import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, Err, Loading, Notice, PLATFORM_LABEL, PlatformBadge, Status, useAction, useLoad, download, fmtDay } from '../ui';

export function CampaignsPage() {
  const { data, error, loading } = useLoad(() => api.get('/campaigns'));
  const { data: sources } = useLoad(() => api.get('/sources'));
  const [f, setF] = useState<any>({ name: '', objective: '', startDate: '', endDate: '', product: '', audience: '', keyMessages: '', channels: ['threads', 'x', 'linkedin'], sourceIds: [] as string[] });
  const a = useAction();
  const nav = useNavigate();
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => api.post('/campaigns', { ...f, startDate: f.startDate || null, endDate: f.endDate || null, keyMessages: f.keyMessages.split('\n').map((s: string) => s.trim()).filter(Boolean) }));
    if (r) {
      await api.post(`/campaigns/${r.id}/sequence`, {});
      nav(`/campaigns/${r.id}`);
    }
  };
  return (
    <div className="page">
      <h1>キャンペーン</h1>
      {loading && <Loading />}
      <Err e={error} />
      {data && (data.length ? (
        <ul className="list big">
          {data.map((c: any) => <li key={c.id}><Link to={`/campaigns/${c.id}`}><b>{c.name}</b></Link> <span className="tag">{c.status}</span> <span className="small muted">{c.startDate ?? '—'} 〜 {c.endDate ?? '—'}</span></li>)}
        </ul>
      ) : <Empty>キャンペーンはまだありません</Empty>)}
      <Card title="新しいキャンペーン">
        <form className="stack" onSubmit={create}>
          <div className="grid2 tight">
            <label>名前<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例: 新アプリ発売" /></label>
            <label>商品<input value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })} /></label>
            <label>開始日<input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
            <label>終了日<input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          </div>
          <label>目的<input value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} /></label>
          <label>対象<input value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} /></label>
          <label>Key Message（1行に1つ）<textarea rows={3} value={f.keyMessages} onChange={(e) => setF({ ...f, keyMessages: e.target.value })} /></label>
          <fieldset><legend>Channel</legend><div className="row wrap">
            {Object.entries(PLATFORM_LABEL).map(([v, l]) => <label key={v} className="check"><input type="checkbox" checked={f.channels.includes(v)} onChange={(e) => setF({ ...f, channels: e.target.checked ? [...f.channels, v] : f.channels.filter((x: string) => x !== v) })} />{l}</label>)}
          </div></fieldset>
          <fieldset><legend>使う素材</legend><div className="row wrap">
            {(sources ?? []).map((s: any) => <label key={s.id} className="check"><input type="checkbox" checked={f.sourceIds.includes(s.id)} onChange={(e) => setF({ ...f, sourceIds: e.target.checked ? [...f.sourceIds, s.id] : f.sourceIds.filter((x: string) => x !== s.id) })} />{s.title}</label>)}
          </div></fieldset>
          <Err e={a.error} />
          <button className="btn primary" disabled={a.busy}>作成して8段階のDraft計画を作る</button>
        </form>
      </Card>
    </div>
  );
}

export function CampaignDetail() {
  const { id } = useParams();
  const { data: c, error, loading, reload } = useLoad(() => api.get(`/campaigns/${id}`), [id]);
  const a = useAction();
  if (loading && !c) return <Loading />;
  if (error) return <Err e={error} />;
  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1>{c.name}</h1>
          <p className="small muted">{c.objective}・{c.startDate} 〜 {c.endDate}・{c.channels.map((x: string) => PLATFORM_LABEL[x]).join(' / ')}</p>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={a.busy} onClick={async () => { await a.run(() => api.post(`/campaigns/${c.id}/sequence`, {})); reload(); }}>未作成ステップを再計画</button>
          <button className="btn" onClick={() => download(api.url(`/campaigns/${c.id}/export.csv`))}>カレンダーCSV</button>
        </div>
      </div>
      <Err e={a.error} />
      <Card title="Campaign Guard">
        {c.guard.warnings.length ? <ul className="list">{c.guard.warnings.map((w: any, i: number) => <li key={i} className="sev-warn"><span className="tag">{w.kind}</span> {w.message}</li>)}</ul> : <p className="ok-t small">確認事項はありません</p>}
        <p className="small muted">{c.guard.note}</p>
      </Card>
      <Card title="シーケンス（Teaser → Reminder）">
        <ol className="timeline">
          {c.steps.map((s: any) => {
            const item = c.items.find((i: any) => i.id === s.contentId);
            return (
              <li key={s.id}>
                <div className="tl-h"><b>{s.stage}</b> <span className="small">{s.plannedDate}</span> {s.platform && <PlatformBadge p={s.platform} />}</div>
                {s.keyMessage && <div className="small muted">Key: {s.keyMessage}</div>}
                {item ? (
                  <Link to={`/content/${item.id}`}>{item.body.slice(0, 80)}… <Status s={item.status} /></Link>
                ) : (
                  <button className="btn sm" disabled={a.busy} onClick={async () => { await a.run(() => api.post(`/campaigns/${c.id}/steps/${s.id}/draft`, {})); reload(); }}>Draftを作る</button>
                )}
              </li>
            );
          })}
        </ol>
        {!c.steps.length && <Empty>ステップがありません。「再計画」を押してください。</Empty>}
      </Card>
      <Card title="Key Message">{c.keyMessages.length ? <ul className="list">{c.keyMessages.map((k: string) => <li key={k}>{k}</li>)}</ul> : <Empty>未設定</Empty>}</Card>
    </div>
  );
}

export function CalendarPage() {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const from = new Date(month.getFullYear(), month.getMonth(), 1);
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const { data, error, loading } = useLoad(() => api.get(`/calendar?from=${from.toISOString()}&to=${to.toISOString()}`), [month.getTime()]);
  const [filter, setFilter] = useState('');
  const days = useMemo(() => {
    const out: Date[] = [];
    const start = new Date(from);
    start.setDate(1 - ((from.getDay() + 6) % 7));
    for (let i = 0; i < 42; i++) out.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    return out;
  }, [month.getTime()]);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const entries = (data?.entries ?? []).filter((e: any) => !filter || e.status === filter);
  return (
    <div className="page">
      <div className="hero">
        <h1>カレンダー</h1>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="前月">‹</button>
          <b>{month.getFullYear()}年{month.getMonth() + 1}月</b>
          <button className="btn sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="翌月">›</button>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="状態フィルタ">
            <option value="">すべて</option>
            {['approved', 'scheduled', 'published', 'failed', 'needs_review', 'draft'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      {data && <p className="small muted">表示タイムゾーン: {data.timezone}{data.__fromCache ? '（オフライン: キャッシュ表示）' : ''}{data.truncated ? '・件数が多いため先頭1,500件のみ表示（状態で絞り込んでください）' : ''}</p>}
      {loading && <Loading />}
      <Err e={error} />
      <div className="cal">
        {['月', '火', '水', '木', '金', '土', '日'].map((w) => <div key={w} className="cal-w">{w}</div>)}
        {days.map((d) => {
          const k = key(d);
          const es = entries.filter((e: any) => e.localDate === k);
          const steps = (data?.plannedSteps ?? []).filter((s: any) => s.date === k);
          return (
            <div key={k} className={`cal-d ${d.getMonth() !== month.getMonth() ? 'out' : ''}`}>
              <span className="cal-n">{d.getDate()}</span>
              {es.map((e: any) => <Link key={e.contentId} to={`/content/${e.contentId}`} className={`cal-e s-${e.status}`}>{e.localTime} {PLATFORM_LABEL[e.platform]?.slice(0, 8)} {e.mode === 'manual' ? '✋' : e.mode === 'api' ? '⚡' : ''}</Link>)}
              {steps.map((s: any) => <Link key={s.stepId} to={`/campaigns/${s.campaignId}`} className="cal-e plan">予定: {s.stage}</Link>)}
            </div>
          );
        })}
      </div>
      <Card title="一覧（スマホ向け）" className="cal-list">
        {entries.length ? <ul className="list">{entries.map((e: any) => <li key={e.contentId}><Link to={`/content/${e.contentId}`}>{fmtDay(e.at)} {e.localTime} <PlatformBadge p={e.platform} /> {e.title}</Link> <Status s={e.status} /></li>)}</ul> : <Empty>この月の予定はありません</Empty>}
      </Card>
      <Notice kind="info">⚡ = API予約（Connector対応のみ）、✋ = 手動投稿リマインダー。API非対応のPlatformは手動投稿になります。</Notice>
    </div>
  );
}
