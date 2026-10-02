import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Card, Empty, Err, Loading, Notice, Tabs, useAction, useLoad, fmtDate, RIGHTS_LABEL, ANGLE_LABEL, Status, download } from '../ui';

const TYPES: [string, string][] = [
  ['video', '動画'], ['audio', '音声'], ['podcast', 'Podcast'], ['article', '記事'], ['blog', 'ブログ'], ['pdf', 'PDF'], ['document', 'ドキュメント'],
  ['transcript', '文字起こし'], ['web_url', 'Web URL'], ['image_set', '画像セット'], ['manual_idea', 'メモ/アイデア'], ['product_page', '商品ページ'], ['other', 'その他'],
];
export const TYPE_LABEL = Object.fromEntries(TYPES);

export function SourcesPage() {
  const { data, error, loading } = useLoad(() => api.get('/sources'));
  return (
    <div className="page">
      <div className="hero">
        <h1>素材（Source）</h1>
        <Link className="btn primary" to="/sources/new">＋ 素材を追加</Link>
      </div>
      {loading && <Loading />}
      <Err e={error} />
      {data && (data.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>タイトル</th><th>種類</th><th>権利</th><th>状態</th><th>取込日</th></tr></thead>
            <tbody>
              {data.map((s: any) => (
                <tr key={s.id}>
                  <td><Link to={`/sources/${s.id}`}>{s.title}</Link>{s.evergreen && <span className="tag">Evergreen</span>}</td>
                  <td>{TYPE_LABEL[s.type] ?? s.type}</td>
                  <td className={s.rightsStatus === 'unknown' ? 'warn-t' : ''}>{RIGHTS_LABEL[s.rightsStatus]}</td>
                  <td>{s.status}</td>
                  <td className="small">{fmtDate(s.importedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>まだ素材がありません。</Empty>)}
    </div>
  );
}

export function NewSource() {
  const nav = useNavigate();
  const [mode, setMode] = useState<'text' | 'url' | 'transcript' | 'file'>('text');
  const [f, setF] = useState<any>({ type: 'article', title: '', text: '', url: '', transcript: '', rightsStatus: 'owned', author: '', publishedAt: '', fetchUrl: true, aiEligible: true, evergreen: false });
  const [file, setFile] = useState<File | null>(null);
  const a = useAction();
  const [dup, setDup] = useState<any>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDup(null);
    const r = await a.run(async () => {
      let mediaId: string | undefined;
      if (mode === 'file' && file) {
        const fd = new FormData();
        fd.append('file', file);
        const m = await api.post('/media', fd);
        mediaId = m.id;
      }
      const body: any = { type: f.type, title: f.title || f.url || file?.name || '無題', rightsStatus: f.rightsStatus, author: f.author || null, publishedAt: f.publishedAt || null, aiEligible: f.aiEligible, evergreen: f.evergreen };
      if (mode === 'text') body.text = f.text;
      if (mode === 'url') Object.assign(body, { url: f.url, fetchUrl: f.fetchUrl, text: f.text || undefined });
      if (mode === 'transcript') Object.assign(body, { transcript: f.transcript, url: f.url || undefined });
      if (mode === 'file') Object.assign(body, { mediaId, text: f.text || undefined, transcript: f.transcript || undefined });
      try {
        return await api.post('/sources', body);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setDup(err.details);
        throw err;
      }
    });
    if (r) nav(`/sources/${r.id}`);
  };
  const readTextFile = async (fl: File | undefined) => {
    if (!fl) return;
    const t = await fl.text();
    set(mode === 'transcript' ? 'transcript' : 'text', t);
    if (!f.title) set('title', fl.name.replace(/\.[^.]+$/, ''));
  };
  return (
    <div className="page narrow">
      <h1>素材を追加</h1>
      <p className="muted">自分が権利を持つ、または利用許可のある素材を登録してください。第三者の文章を長く転載する用途には使えません。</p>
      <Tabs value={mode} onChange={setMode} items={[{ id: 'text', label: 'テキスト貼り付け' }, { id: 'url', label: 'URL' }, { id: 'transcript', label: '文字起こし(SRT/VTT)' }, { id: 'file', label: 'ファイル' }]} />
      <form className="stack card" onSubmit={submit}>
        <div className="grid2 tight">
          <label>種類
            <select value={f.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label>タイトル<input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="例: AIコーディング失敗談3つ" /></label>
        </div>
        {mode === 'text' && (
          <label>本文<textarea rows={12} value={f.text} onChange={(e) => set('text', e.target.value)} required placeholder="記事・台本・商品説明・メモなどを貼り付け" />
            <input type="file" accept=".txt,.md" onChange={(e) => readTextFile(e.target.files?.[0])} aria-label="テキストファイルから読み込む" />
          </label>
        )}
        {mode === 'url' && (
          <>
            <label>URL<input type="url" value={f.url} onChange={(e) => set('url', e.target.value)} required placeholder="https://" /></label>
            <label className="check"><input type="checkbox" checked={f.fetchUrl} onChange={(e) => set('fetchUrl', e.target.checked)} />このページ1件の本文を取得する（クロールはしません・内部アドレスは拒否）</label>
            <label>本文（任意・取得できない場合に貼り付け）<textarea rows={5} value={f.text} onChange={(e) => set('text', e.target.value)} /></label>
          </>
        )}
        {mode === 'transcript' && (
          <>
            <label>文字起こし（SRT / VTT / [mm:ss] 形式）<textarea rows={12} value={f.transcript} onChange={(e) => set('transcript', e.target.value)} required placeholder={'1\n00:00:00,000 --> 00:00:05,000\nこんにちは…'} /></label>
            <input type="file" accept=".srt,.vtt,.txt" onChange={(e) => readTextFile(e.target.files?.[0])} aria-label="字幕ファイルから読み込む" />
            <label>元動画URL（任意）<input type="url" value={f.url} onChange={(e) => set('url', e.target.value)} /></label>
            <p className="small muted">聞き取れない箇所は [inaudible] のままにしてください。AIが内容を補完することはありません。</p>
          </>
        )}
        {mode === 'file' && (
          <>
            <label>ファイル（画像/PDF/音声/動画）<input type="file" accept="image/*,application/pdf,audio/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></label>
            <p className="small muted">動画/音声の文字起こしは、AIプロバイダ設定時のみ実行できます。字幕ファイルがあれば下に貼り付けてください。</p>
            <label>文字起こし（任意）<textarea rows={5} value={f.transcript} onChange={(e) => set('transcript', e.target.value)} /></label>
          </>
        )}
        <div className="grid2 tight">
          <label>権利
            <select value={f.rightsStatus} onChange={(e) => set('rightsStatus', e.target.value)}>{Object.entries(RIGHTS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label>作成者<input value={f.author} onChange={(e) => set('author', e.target.value)} /></label>
          <label>公開日<input type="date" value={f.publishedAt} onChange={(e) => set('publishedAt', e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.aiEligible} onChange={(e) => set('aiEligible', e.target.checked)} />外部AIへの送信を許可（OFFの場合は抽出エンジンのみで処理）</label>
        <label className="check"><input type="checkbox" checked={f.evergreen} onChange={(e) => set('evergreen', e.target.checked)} />Evergreen（長く再利用できる素材）</label>
        {f.rightsStatus !== 'owned' && f.rightsStatus !== 'licensed' && <Notice kind="warn">権利が「自分の素材/ライセンス取得済み」以外の場合、引用は短く出典付きで扱われます。</Notice>}
        {dup && <Notice kind="warn">同じ内容の素材が登録済みです: <Link to={`/sources/${dup.existingId}`}>{dup.title}</Link></Notice>}
        <Err e={a.error} />
        <button className="btn primary" disabled={a.busy}>{a.busy ? '解析中…' : '登録して解析'}</button>
      </form>
    </div>
  );
}

export function SourceDetail() {
  const { id } = useParams();
  const { data: s, error, loading, reload } = useLoad(() => api.get(`/sources/${id}`), [id]);
  const nav = useNavigate();
  const a = useAction();
  const [counts, setCounts] = useState<Record<string, number>>({ short_video: 3, threads: 4, x: 4, linkedin: 2, instagram_carousel: 1, blog: 1, newsletter: 1, quote: 3 });
  const [tab, setTab] = useState<'ideas' | 'analysis' | 'transcript' | 'text'>('ideas');
  if (loading && !s) return <Loading />;
  if (error) return <Err e={error} />;
  const an = s.analysis;
  const makePack = async () => {
    const p = await a.run(() => api.post('/packs', { sourceIds: [s.id], counts }));
    if (p) nav(`/packs/${p.id}`);
  };
  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1>{s.title}</h1>
          <p className="small muted">{TYPE_LABEL[s.type]}・{RIGHTS_LABEL[s.rightsStatus]}・{s.language ?? '-'}・取込 {fmtDate(s.importedAt)}{s.url && <> ・ <a href={s.url} target="_blank" rel="noreferrer noopener">元URL</a></>}</p>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={a.busy || !an} onClick={async () => { await a.run(() => api.post(`/sources/${s.id}/ideas`, {})); reload(); }}>Ideaを抽出</button>
          <button className="btn danger" disabled={a.busy} onClick={async () => { if (confirm('この素材を削除します。文字起こし・検索インデックス・ベクトル・メディアも削除されます（作成済みのIdea/Contentは残ります）。')) { await a.run(() => api.del(`/sources/${s.id}`)); nav('/sources'); } }}>削除</button>
        </div>
      </div>
      <Err e={a.error} />
      {!an && <Notice kind="warn">本文/文字起こしがまだありません。動画・音声の場合は文字起こし（SRT/VTT）を添付してください。</Notice>}
      {an && (
        <Card title="Content Packを作る" actions={<button className="btn primary" disabled={a.busy} onClick={makePack}>{a.busy ? '作成中…' : 'まとめて作成'}</button>}>
          <p className="small muted">1つの素材から各SNS向けのDraftをまとめて作ります。数は変更できます。投稿はされません。</p>
          <div className="counts">
            {Object.entries(counts).map(([k, v]) => (
              <label key={k}>{({ short_video: 'ショート動画', threads: 'Threads', x: 'X', linkedin: 'LinkedIn', instagram_carousel: 'Instagram Carousel', blog: 'ブログ', newsletter: 'ニュースレター', quote: '引用' } as any)[k]}
                <input type="number" min={0} max={30} value={v} onChange={(e) => setCounts({ ...counts, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
        </Card>
      )}
      <Tabs value={tab} onChange={setTab} items={[{ id: 'ideas', label: `Idea (${s.ideas.length})` }, { id: 'analysis', label: '解析' }, { id: 'transcript', label: `Transcript (${s.segments.length})` }, { id: 'text', label: '本文' }]} />
      {tab === 'ideas' && (
        <Card>
          {s.ideas.length ? (
            <ul className="list">
              {s.ideas.map((i: any) => (
                <li key={i.id}><Link to={`/ideas/${i.id}`}>{i.coreIdea}</Link> <span className="tag">{ANGLE_LABEL[i.angle] ?? i.angle}</span> <span className="tag">{i.topic}</span> <Status s={i.status} /></li>
              ))}
            </ul>
          ) : <Empty>「Ideaを抽出」を押すと、素材から投稿ネタを抜き出します。</Empty>}
        </Card>
      )}
      {tab === 'analysis' && an && (
        <div className="grid2">
          <Card title="トピック"><div className="row wrap">{an.topics.map((t: string) => <span key={t} className="tag">{t}</span>)}</div></Card>
          <Card title="展開のヒント"><ul className="list">{an.opportunities.map((o: string) => <li key={o}>{o}</li>)}</ul></Card>
          <Card title="要点"><ol>{an.keyPoints.map((k: any) => <li key={k.sentence}>{k.text}</li>)}</ol></Card>
          <Card title="引用候補"><ul className="list">{an.quotes.slice(0, 10).map((q: string) => <li key={q}>「{q}」</li>)}</ul></Card>
          <Card title="事実・数値の主張（要確認）">{an.claims.length ? <ul className="list">{an.claims.map((c: any) => <li key={c.text}><span className="tag">{c.kind}</span> {c.text}</li>)}</ul> : <Empty>なし</Empty>}<p className="small muted">価格・数値などはClaim Registryに登録すると、古い値の使用を警告できます。</p></Card>
          <Card title="解析エンジン"><p className="small">{an.engine}（抽出ベース。素材にない事実は作りません）</p></Card>
        </div>
      )}
      {tab === 'transcript' && (
        <Card actions={s.segments.length ? <><button className="btn sm" onClick={() => download(api.url(`/sources/${s.id}/subtitles?format=srt`))}>SRT</button><button className="btn sm" onClick={() => download(api.url(`/sources/${s.id}/subtitles?format=vtt`))}>VTT</button></> : null}>
          {s.segments.length ? (
            <ol className="segments">{s.segments.map((g: any) => <li key={g.idx} className={g.inaudible ? 'muted' : ''}><code>{ts(g.startMs)}</code> {g.inaudible ? '［聞き取れない部分］' : g.text}</li>)}</ol>
          ) : <AttachTranscript id={s.id} onDone={reload} />}
        </Card>
      )}
      {tab === 'text' && <Card><pre className="pre">{s.text || '（本文なし）'}</pre></Card>}
    </div>
  );
}

function AttachTranscript({ id, onDone }: { id: string; onDone: () => void }) {
  const [t, setT] = useState('');
  const a = useAction();
  return (
    <div className="stack">
      <Empty>文字起こしはまだありません。</Empty>
      <textarea rows={6} value={t} onChange={(e) => setT(e.target.value)} placeholder="SRT/VTTを貼り付け" aria-label="文字起こし" />
      <Err e={a.error} />
      <button className="btn" disabled={!t || a.busy} onClick={async () => { await a.run(() => api.post(`/sources/${id}/transcript`, { transcript: t })); onDone(); }}>文字起こしを添付</button>
    </div>
  );
}

const ts = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
