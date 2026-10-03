import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ANGLE_LABEL, Card, Empty, Err, Loading, Notice, PLATFORM_LABEL, PlatformBadge, Status, Tabs, fmtDate, graphemes, useAction, useLoad, download } from '../ui';
import { SimilarityList } from './Ideas';
import { offlineQueue, useOnline, useSession } from '../App';

const MAX: Record<string, number> = { threads: 500, x: 280, linkedin: 3000, instagram: 2200, facebook: 63206, tiktok: 2200, youtube_shorts: 5000, youtube_community: 1500, blog: 20000, newsletter: 15000, generic: 5000 };
function platformLen(p: string, s: string) {
  if (p !== 'x') return graphemes(s);
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0)! <= 0x10ff ? 1 : 2);
  return n;
}

export function ContentList() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const platform = sp.get('platform') ?? '';
  const { data, error, loading } = useLoad(() => api.get(`/content?${new URLSearchParams({ ...(status ? { status } : {}), ...(platform ? { platform } : {}) })}`), [status, platform]);
  return (
    <div className="page">
      <h1>コンテンツ</h1>
      <div className="row wrap">
        <select value={status} onChange={(e) => setSp({ status: e.target.value, platform })} aria-label="状態">
          <option value="">すべての状態</option>
          {['draft', 'needs_review', 'approved', 'scheduled', 'published', 'failed', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={platform} onChange={(e) => setSp({ status, platform: e.target.value })} aria-label="Platform">
          <option value="">すべてのPlatform</option>
          {Object.entries(PLATFORM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {loading && <Loading />}
      <Err e={error} />
      {data && <ContentTable items={data} />}
    </div>
  );
}

function ContentTable({ items }: { items: any[] }) {
  if (!items.length) return <Empty>該当するコンテンツはありません</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Platform</th><th>内容</th><th>状態</th><th>日時</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td><PlatformBadge p={c.platform} /></td>
              <td><Link to={`/content/${c.id}`}>{(c.title ?? c.body).slice(0, 70)}</Link></td>
              <td><Status s={c.status} />{c.publishedVia && <span className="tag">{c.publishedVia === 'api_confirmed' ? 'API確認済' : c.publishedVia === 'imported' ? 'Import' : '手動マーク'}</span>}</td>
              <td className="small">{fmtDate(c.scheduledAt ?? c.publishedAt ?? c.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReviewQueue() {
  const { data, error, loading } = useLoad(() => api.get('/content?status=needs_review'));
  return (
    <div className="page">
      <h1>レビュー待ち</h1>
      <p className="muted">Editor → Reviewer → Approved。承認後に本文を変更すると、再レビューが必要になります（設定で変更可）。</p>
      {loading && <Loading />}
      <Err e={error} />
      {data && <ContentTable items={data} />}
    </div>
  );
}

export function PackDetail() {
  const { id } = useParams();
  const { data: p, error, loading } = useLoad(() => api.get(`/packs/${id}`), [id]);
  const [kind, setKind] = useState('all');
  if (loading && !p) return <Loading />;
  if (error) return <Err e={error} />;
  const kinds = Object.keys(p.byKind);
  const items = p.items.filter((i: any) => kind === 'all' || (i.structured?.packKind ?? i.platform) === kind);
  const KL: Record<string, string> = { short_video: 'ショート動画', threads: 'Threads', x: 'X投稿', linkedin: 'LinkedIn', instagram_carousel: 'Instagram', blog: 'ブログ', newsletter: 'ニュースレター', quote: '引用・名言' };
  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1>コンテンツパック</h1>
          <p className="small muted">{fmtDate(p.createdAt)}・生成: {p.generator}・{p.items.length}件・Source: {p.sourceIds.map((s: string) => <Link key={s} to={`/sources/${s}`}>{s.slice(0, 10)} </Link>)}</p>
        </div>
        <button className="btn" onClick={() => download(api.url(`/packs/${p.id}/zip`))}>ZIPで書き出し</button>
      </div>
      <div className="pack-grid">
        <button className={`pack-k ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}><b>{p.items.length}</b><span>すべて</span></button>
        {kinds.map((k) => (
          <button key={k} className={`pack-k ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}><b>{p.byKind[k]}本</b><span>{KL[k] ?? k}</span></button>
        ))}
      </div>
      <div className="cards">
        {items.map((i: any) => (
          <Link key={i.id} to={`/content/${i.id}`} className="ccard">
            <div className="row"><PlatformBadge p={i.platform} /><Status s={i.status} /></div>
            {i.title && <b>{i.title}</b>}
            <p>{i.body.slice(0, 160)}{i.body.length > 160 ? '…' : ''}</p>
            {i.structured?.start && <span className="small">クリップ {i.structured.start}–{i.structured.end}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Preview({ c, body }: { c: any; body: string }) {
  const st = c.structured ?? {};
  if (c.format === 'carousel' && st.slides) {
    return (
      <div className="carousel">
        {st.slides.map((s: any, i: number) => (
          <div key={i} className={`slide sl-${s.kind}`}><span className="small">{i + 1}/{st.slides.length}・{s.kind}</span><p>{s.text}</p></div>
        ))}
      </div>
    );
  }
  return (
    <div className={`preview pv-${c.platform}`}>
      <div className="pv-h"><span className="pv-avatar" aria-hidden /> <b>Your Brand</b> <span className="small muted">・{PLATFORM_LABEL[c.platform]}</span></div>
      {c.format === 'article' || c.format === 'newsletter' ? <div className="pv-article">{c.title && <h3>{c.title}</h3>}<pre className="pre">{body}</pre></div> : <p className="pv-body">{body}</p>}
      {c.format === 'short_video' && st.start && <p className="small">クリップ: {st.start} – {st.end}（{st.topic}）<br />なぜ役立つ: {st.whyUseful}</p>}
    </div>
  );
}

export function ContentEditor() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get(`/content/${id}`), [id]);
  const { workspace } = useSession();
  const online = useOnline();
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'offline' | 'conflict'>('saved');
  const [tab, setTab] = useState<'checks' | 'publish' | 'history' | 'performance'>('checks');
  const a = useAction();
  const nav = useNavigate();
  const versionRef = useRef<number>(0);
  const timer = useRef<any>(null);
  // latest values for debounced autosave (avoid stale closures)
  const bodyRef = useRef('');
  const titleRef = useRef('');
  useEffect(() => {
    if (data) {
      setBody(data.content.body);
      setTitle(data.content.title ?? '');
      bodyRef.current = data.content.body;
      titleRef.current = data.content.title ?? '';
      versionRef.current = data.content.version;
      setSaveState('saved');
    }
  }, [data?.content.id, data?.content.version]);
  const c = data?.content;
  const len = useMemo(() => (c ? platformLen(c.platform, body) : 0), [body, c?.platform]);

  const save = async (autosave: boolean) => {
    if (!c) return;
    const body = bodyRef.current;
    const title = titleRef.current;
    if (!navigator.onLine) {
      offlineQueue.enqueue({ kind: 'draft', workspaceId: workspace.id, contentId: c.id, payload: { body, title: title || null, expectedVersion: versionRef.current, autosave: true } });
      setSaveState('offline');
      return;
    }
    setSaveState('saving');
    try {
      const r = await api.patch(`/content/${c.id}`, { body, title: title || null, expectedVersion: versionRef.current, autosave });
      versionRef.current = r.content.version;
      setSaveState('saved');
      if (r.reReviewRequired || !autosave) reload();
    } catch (e: any) {
      setSaveState(e?.status === 409 ? 'conflict' : 'dirty');
      a.setError(e);
    }
  };
  const onChange = (v: string) => {
    setBody(v);
    bodyRef.current = v;
    setSaveState('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(true), 1500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  if (loading && !data) return <Loading />;
  if (error) return <Err e={error} />;
  const ch = data.checks;
  const max = MAX[c.platform] ?? 5000;
  const act = async (fn: () => Promise<any>) => {
    const r = await a.run(fn);
    if (r !== undefined) reload();
    return r;
  };
  const published = c.status === 'published';
  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1><PlatformBadge p={c.platform} /> {c.format}</h1>
          <p className="small muted">
            <Status s={c.status} /> v{c.version}{c.approvedVersion ? `（承認v${c.approvedVersion}）` : ''}・
            {c.ideaId && <Link to={`/ideas/${c.ideaId}`}>Idea</Link>}
            {c.sourceIds.map((s: string) => <Link key={s} to={`/sources/${s}`}> ・Source</Link>)}
            {c.parentContentId && <Link to={`/content/${c.parentContentId}`}> ・元Content</Link>}
            {c.publishedVia && <span className="tag">{c.publishedVia === 'api_confirmed' ? 'API確認済みPublished' : c.publishedVia === 'imported' ? 'Import' : 'ユーザーがPublished登録'}</span>}
          </p>
        </div>
        <div className="row wrap">
          {['draft', 'failed', 'recycling_candidate'].includes(c.status) && <button className="btn" disabled={a.busy} onClick={() => act(() => api.post(`/content/${c.id}/review`, {}))}>レビュー依頼</button>}
          {['needs_review', 'draft'].includes(c.status) && ['owner', 'admin', 'reviewer'].includes(workspace.role) && (
            <>
              <button className="btn primary" disabled={a.busy || ch.blocking} onClick={() => act(() => api.post(`/content/${c.id}/approve`, {}))}>承認</button>
              <button className="btn" disabled={a.busy} onClick={() => { const m = prompt('修正依頼の内容'); if (m) act(() => api.post(`/content/${c.id}/request-changes`, { comment: m })); }}>修正依頼</button>
            </>
          )}
          {!published && <button className="btn" disabled={a.busy} onClick={() => act(() => api.post(`/content/${c.id}/archive`, {}))}>アーカイブ</button>}
        </div>
      </div>
      <Err e={a.error} />
      {c.status === 'needs_review' && c.approvedVersion && c.approvedVersion !== c.version && <Notice kind="warn">承認後に本文が変更されたため、再レビューが必要です。</Notice>}
      {ch.blocking && <Notice kind="err">ブロック項目があります（下のチェックを確認）。承認・自動投稿はできません。</Notice>}
      <div className="editor">
        <div className="stack">
          {(c.format === 'article' || c.format === 'newsletter' || c.title) && (
            <label>タイトル/件名<input value={title} disabled={published} onChange={(e) => { setTitle(e.target.value); titleRef.current = e.target.value; setSaveState('dirty'); clearTimeout(timer.current); timer.current = setTimeout(() => save(true), 1500); }} /></label>
          )}
          <label>
            本文
            <textarea className="body-edit" rows={c.format === 'article' ? 22 : 10} value={body} disabled={published} onChange={(e) => onChange(e.target.value)} />
          </label>
          <div className="row between small">
            <span className={len > max ? 'err-t' : ''}>{len} / {max}{c.platform === 'x' ? '（X重み付け概算）' : ''}</span>
            <span className={`save s-${saveState}`}>{{ saved: '保存済み', dirty: '未保存', saving: '保存中…', offline: '端末に保存（未同期）', conflict: '競合: 他の変更あり' }[saveState]}</span>
          </div>
          {!online && <Notice kind="warn">オフラインです。編集は端末に保存され、再接続時に同期されます（投稿・予約はできません）。</Notice>}
          {saveState === 'conflict' && <Notice kind="err">サーバー側で新しい版が保存されています。<button className="link" onClick={() => reload()}>最新版を読み込む</button></Notice>}
          {!published && (
            <div className="row wrap">
              <button className="btn" disabled={a.busy || saveState === 'saving'} onClick={() => save(false)}>版として保存</button>
              <select aria-label="再生成の角度" id="regen-angle" defaultValue="">
                <option value="">角度: そのまま</option>
                {Object.entries(ANGLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button className="btn" disabled={a.busy} onClick={async () => { const angle = (document.getElementById('regen-angle') as HTMLSelectElement).value || undefined; const r = await act(() => api.post(`/content/${c.id}/regenerate`, { angle })); if (r) alert(r.message); }}>AIで再生成</button>
            </div>
          )}
          {c.aiSuggestion && (
            <Card title="AIの提案（本文は変更されていません）" actions={<button className="btn sm" onClick={() => act(() => api.post(`/content/${c.id}/accept-suggestion`, {}))}>提案を採用</button>}>
              <pre className="pre">{c.aiSuggestion.body}</pre>
            </Card>
          )}
          {(c.structured?.notes ?? []).map((n: string) => <Notice key={n} kind="info">{n}</Notice>)}
        </div>
        <div className="stack">
          <h3 className="small muted">プレビュー</h3>
          <Preview c={c} body={body} />
          <div className="row wrap">
            <span className="small">別Platformへ変換:</span>
            <select aria-label="変換先" onChange={async (e) => { if (!e.target.value) return; const r = await a.run(() => api.post(`/content/${c.id}/transform`, { platform: e.target.value })); if (r) nav(`/content/${r.content.id}`); }} defaultValue="">
              <option value="">選択…</option>
              {Object.entries(PLATFORM_LABEL).filter(([v]) => v !== c.platform).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className="btn sm" onClick={async () => { const loc = prompt('翻訳先のロケール (例: en, zh-TW)'); if (!loc) return; const r = await a.run(() => api.post(`/content/${c.id}/localize`, { locale: loc })); if (r) nav(`/content/${r.id}`); }}>翻訳</button>
          </div>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'checks', label: `チェック${ch.blocking ? ' ⚠' : ''}` }, { id: 'publish', label: '投稿・予約' }, { id: 'history', label: '履歴・コメント' }, { id: 'performance', label: '反応' }]} />
      {tab === 'checks' && <Checks ch={ch} />}
      {tab === 'publish' && <PublishPanel data={data} reload={reload} />}
      {tab === 'history' && <History data={data} reload={reload} />}
      {tab === 'performance' && <PerfPanel data={data} reload={reload} />}
    </div>
  );
}

function Checks({ ch }: { ch: any }) {
  return (
    <div className="grid2">
      <Card title="Brand Guard">
        {ch.brandGuard.length ? <ul className="list">{ch.brandGuard.map((g: any, i: number) => <li key={i} className={`sev-${g.severity}`}><span className="tag">{g.severity}</span> {g.message}{g.excerpt && <div className="small muted">「{g.excerpt}」</div>}</li>)}</ul> : <p className="ok-t small">問題は見つかりませんでした</p>}
        <p className="small muted">個別のチェック結果です。単一のスコアで品質を断定しません。</p>
      </Card>
      <Card title="ネタ重複（Idea Fingerprint）"><SimilarityList items={ch.similar} /></Card>
      <Card title="再利用ルール">{ch.reuse.length ? <ul className="list">{ch.reuse.map((r: any, i: number) => <li key={i} className={`sev-${r.severity}`}>{r.message}</li>)}</ul> : <p className="ok-t small">該当なし</p>}</Card>
      <Card title="鮮度（Freshness）">{ch.freshness.length ? <ul className="list">{ch.freshness.map((f: any, i: number) => <li key={i} className="sev-warn"><span className="tag">{f.label}</span> {f.message}<div className="small muted">「{f.excerpt}」</div></li>)}</ul> : <p className="ok-t small">日付依存の主張は見つかりませんでした</p>}</Card>
      <Card title="Claim Registry">{ch.claims.length ? <ul className="list">{ch.claims.map((c: any, i: number) => <li key={i} className={`sev-${c.severity}`}>{c.message}</li>)}</ul> : <p className="ok-t small">問題なし</p>}</Card>
      <Card title="出典">{ch.sourceRefs.length ? <ul className="list">{ch.sourceRefs.map((s: any) => <li key={s.id}><Link to={`/sources/${s.id}`}>{s.title}</Link> <span className="tag">{s.rightsStatus}</span></li>)}</ul> : <Empty>出典なし</Empty>}</Card>
    </div>
  );
}

function PublishPanel({ data, reload }: { data: any; reload: () => void }) {
  const c = data.content;
  const { workspace } = useSession();
  const { data: conn } = useLoad(() => api.get('/connectors'));
  const { data: ws } = useLoad(() => api.get(''));
  const online = useOnline();
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 86400_000);
    d.setMinutes(0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [tz, setTz] = useState(workspace.timezone);
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const a = useAction();
  const cap = conn?.matrix.find((m: any) => m.platform === c.platform);
  const canApi = !!cap?.autoPublish;
  const handoff = async () => {
    const h = await a.run(() => api.get(`/content/${c.id}/handoff`));
    if (!h) return;
    await navigator.clipboard?.writeText(h.text).catch(() => undefined);
    setCopied(true);
    if (h.openUrl && h.openUrl !== 'about:blank') window.open(h.openUrl, '_blank', 'noopener');
  };
  const sched = async (mode: 'api' | 'manual') => {
    const r = await a.run(() => api.post(`/content/${c.id}/schedule`, { localTime: when, timezone: tz, mode }));
    if (r) reload();
  };
  if (c.status === 'published') {
    return (
      <Card title="公開済み">
        <p>{fmtDate(c.publishedAt)}・{c.publishedVia === 'api_confirmed' ? `APIで投稿を確認（ID: ${c.externalPostId}）` : c.publishedVia === 'imported' ? '過去投稿のImport' : 'ユーザーが公開済みとして登録'}</p>
        {c.externalUrl && <a href={c.externalUrl} target="_blank" rel="noreferrer noopener">投稿を開く</a>}
        <RecyclePanel c={c} reload={reload} />
      </Card>
    );
  }
  return (
    <div className="grid2">
      <Card title="このPlatformでできること">
        {cap ? (
          <>
            <div className="row wrap">{cap.effective.map((x: string) => <span key={x} className="tag">{x}</span>)}</div>
            <p className="small">{canApi ? 'Connector経由でAPI投稿できます。' : 'API投稿は利用できません（未接続/非対応）。手動投稿（コピー → SNSを開く → 公開済みにする）を使います。'}</p>
            <p className="small muted">{cap.conditions}</p>
            {cap.connectors.some((x: any) => x.simulated) && <p className="small warn-t">接続中のConnectorはSandbox（シミュレーション）です。実SNSには投稿されません。</p>}
          </>
        ) : <Loading />}
      </Card>
      <Card title="手動投稿（Handoff）">
        <div className="row wrap">
          <button className="btn" onClick={handoff}>本文をコピーしてSNSを開く</button>
          {copied && <span className="ok-t small">コピーしました</span>}
        </div>
        <label>投稿URL（任意）<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label>
        <button className="btn primary" disabled={a.busy || !['approved', 'scheduled'].includes(c.status) && ws?.settings?.requireApprovalBeforePublish} onClick={async () => { const r = await a.run(() => api.post(`/content/${c.id}/mark-published`, { url: url || null })); if (r) reload(); }}>公開済みにする</button>
        <p className="small muted">「ユーザーが公開済みとして登録」として記録され、API確認済みと区別されます。</p>
      </Card>
      <Card title="予約">
        <div className="grid2 tight">
          <label>日時<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <label>タイムゾーン<input value={tz} onChange={(e) => setTz(e.target.value)} /></label>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={a.busy || !online} onClick={() => sched('manual')}>リマインダー予約（手動投稿）</button>
          <button className="btn primary" disabled={a.busy || !canApi || !online || c.status !== 'approved'} title={!canApi ? 'API投稿非対応' : c.status !== 'approved' ? 'Approvedが必要' : ''} onClick={() => sched('api')}>API予約投稿</button>
        </div>
        {!online && <p className="small warn-t">オフライン中は予約できません。</p>}
        {c.status !== 'approved' && <p className="small muted">API予約にはApproved状態が必要です。</p>}
        {data.jobs.length > 0 && (
          <ul className="list">
            {data.jobs.map((j: any) => (
              <li key={j.id}>
                <Status s={j.status} /> {j.mode === 'api' ? 'API' : '手動'}・{fmtDate(j.scheduledAt)}（{j.timezone}）{j.lastError && <span className="small err-t"> {j.lastError}</span>}
                {j.status === 'queued' && <button className="link" onClick={async () => { await a.run(() => api.post(`/jobs/${j.id}/cancel`, {})); reload(); }}>取消</button>}
                {j.status === 'failed' && j.mode === 'api' && <button className="link" onClick={async () => { await a.run(() => api.post(`/jobs/${j.id}/retry`, {})); reload(); }}>再実行（重複確認つき）</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Err e={a.error} />
    </div>
  );
}

function RecyclePanel({ c, reload }: { c: any; reload: () => void }) {
  const a = useAction();
  const nav = useNavigate();
  const go = async (mode: string, platform?: string) => {
    const r = await a.run(() => api.post(`/content/${c.id}/recycle`, { mode, platform }));
    if (r) nav(`/content/${r.content.id}`);
  };
  return (
    <div className="stack">
      <h3>再利用</h3>
      <p className="small">状態: <b>{c.recycleState ?? '未分類'}</b></p>
      <div className="row wrap">
        <button className="btn sm" onClick={() => go('new_angle')}>別角度</button>
        <button className="btn sm" onClick={() => go('different_platform', c.platform === 'threads' ? 'linkedin' : 'threads')}>別Platform</button>
        <button className="btn sm" onClick={() => go('shorter')}>短く</button>
        <button className="btn sm" onClick={() => go('longer')}>長く（ブログ）</button>
        <button className="btn sm" onClick={() => go('updated_facts')}>最新情報で更新</button>
        <button className="btn sm" onClick={() => go('checklist')}>チェックリスト化</button>
      </div>
      <div className="row wrap">
        {['evergreen', 'high_performer', 'seasonal', 'reusable', 'update_needed', 'do_not_reuse'].map((s) => (
          <button key={s} className="btn sm ghost" onClick={async () => { await a.run(() => api.post(`/content/${c.id}/recycle-state`, { state: s })); reload(); }}>{s}</button>
        ))}
      </div>
      <Err e={a.error} />
    </div>
  );
}

function History({ data, reload }: { data: any; reload: () => void }) {
  const [comment, setComment] = useState('');
  const a = useAction();
  return (
    <div className="grid2">
      <Card title="バージョン履歴">
        <ul className="list">
          {data.versions.map((v: any) => (
            <li key={v.version}>
              v{v.version} <span className="tag">{v.author_type === 'ai' ? 'AI Draft' : v.author_type === 'human' ? '人間の編集' : 'Import'}</span> {fmtDate(v.created_at)} {v.note && <span className="small muted">{v.note}</span>}
              {v.version !== data.content.version && data.content.status !== 'published' && <button className="link" onClick={async () => { await a.run(() => api.post(`/content/${data.content.id}/restore`, { version: v.version })); reload(); }}>この版に戻す</button>}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="承認履歴">
        {data.approvals.length ? <ul className="list">{data.approvals.map((x: any) => <li key={x.id}>{x.action}・v{x.version}・{x.actor_name ?? 'system'}・{fmtDate(x.created_at)}{x.comment && <div className="small">{x.comment}</div>}</li>)}</ul> : <Empty>なし</Empty>}
      </Card>
      <Card title="コメント">
        <ul className="list">{data.comments.map((x: any) => <li key={x.id}><b>{x.user_name}</b> {x.body} <span className="small muted">{fmtDate(x.created_at)}</span></li>)}</ul>
        <div className="row"><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="コメント" aria-label="コメント" /><button className="btn sm" disabled={!comment} onClick={async () => { await a.run(() => api.post(`/content/${data.content.id}/comments`, { body: comment })); setComment(''); reload(); }}>送信</button></div>
        <Err e={a.error} />
      </Card>
    </div>
  );
}

function PerfPanel({ data, reload }: { data: any; reload: () => void }) {
  const c = data.content;
  const [m, setM] = useState<Record<string, string>>({ impressions: '', views: '', likes: '', comments: '', shares: '', saves: '', clicks: '' });
  const [win, setWin] = useState('24h');
  const a = useAction();
  if (c.status !== 'published') return <Card><Empty>公開後に反応を記録できます。</Empty></Card>;
  return (
    <div className="grid2">
      <Card title="反応の記録">
        <div className="counts">
          {Object.keys(m).map((k) => <label key={k}>{k}<input inputMode="numeric" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></label>)}
        </div>
        <div className="row wrap">
          <select value={win} onChange={(e) => setWin(e.target.value)} aria-label="期間">{['24h', '7d', '30d', 'custom'].map((w) => <option key={w}>{w}</option>)}</select>
          <button className="btn primary" disabled={a.busy} onClick={async () => { const metrics = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])); await a.run(() => api.post(`/content/${c.id}/snapshots`, { metrics, window: win, source: 'manual' })); reload(); }}>記録</button>
          {c.publishedVia === 'api_confirmed' && <button className="btn" disabled={a.busy} onClick={async () => { await a.run(() => api.post(`/content/${c.id}/pull-metrics`, { window: win })); reload(); }}>Connectorから取得</button>}
        </div>
        <Err e={a.error} />
      </Card>
      <Card title="スナップショット">
        {data.snapshots.length ? (
          <table className="table"><thead><tr><th>取得</th><th>期間</th><th>指標</th><th>元</th></tr></thead><tbody>
            {data.snapshots.map((s: any) => <tr key={s.id}><td className="small">{fmtDate(s.capturedAt)}</td><td>{s.window}</td><td className="small">{Object.entries(s.metrics).map(([k, v]) => `${k}:${v}`).join(' ')}</td><td>{s.source}</td></tr>)}
          </tbody></table>
        ) : <Empty>まだ記録がありません</Empty>}
        <p className="small muted">指標の定義はPlatformごとに異なります。</p>
      </Card>
    </div>
  );
}
