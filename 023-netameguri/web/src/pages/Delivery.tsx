// NetaMeguri 納品パック: pick drafts / a Content Pack / a Campaign → preview → download the client delivery ZIP.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, Err, Loading, Notice, PlatformBadge, Status, fmtDate, useAction, useLoad, download } from '../ui';

type Mode = 'content' | 'pack' | 'campaign';

export function deliveryZipUrl(sel: { contentIds?: string[]; packId?: string; campaignId?: string }) {
  const qs = new URLSearchParams();
  if (sel.contentIds?.length) qs.set('contentIds', sel.contentIds.join(','));
  if (sel.packId) qs.set('packId', sel.packId);
  if (sel.campaignId) qs.set('campaignId', sel.campaignId);
  return api.url(`/delivery-pack.zip?${qs}`);
}

export function DeliveryPage() {
  const [sp] = useSearchParams();
  const [mode, setMode] = useState<Mode>((sp.get('packId') ? 'pack' : sp.get('campaignId') ? 'campaign' : 'content') as Mode);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [packId, setPackId] = useState(sp.get('packId') ?? '');
  const [campaignId, setCampaignId] = useState(sp.get('campaignId') ?? '');
  const [preview, setPreview] = useState<any>(null);
  const a = useAction();
  const content = useLoad(() => api.get(`/content?limit=500${status ? `&status=${status}` : ''}`), [status]);
  const packs = useLoad(() => api.get('/packs'));
  const campaigns = useLoad(() => api.get('/campaigns'));
  const items = useMemo(() => (content.data ?? []).filter((c: any) => c.status !== 'archived').sort((x: any, y: any) => String(x.scheduledAt ?? x.publishedAt ?? '9999').localeCompare(String(y.scheduledAt ?? y.publishedAt ?? '9999'))), [content.data]);
  // keep selection in on-screen order (= post numbers 001, 002, …)
  const orderedSelection = items.filter((c: any) => selected.includes(c.id)).map((c: any) => c.id);
  const sel = mode === 'content' ? { contentIds: orderedSelection } : mode === 'pack' ? { packId } : { campaignId };
  const ready = mode === 'content' ? orderedSelection.length > 0 : mode === 'pack' ? !!packId : !!campaignId;
  const toggle = (id: string, on: boolean) => { setPreview(null); setSelected(on ? [...selected, id] : selected.filter((x) => x !== id)); };
  return (
    <div className="page">
      <h1>NetaMeguri 納品パック</h1>
      <p className="muted">投稿ごとに「画像＋本文＋投稿日」をまとめた、クライアント納品用ZIPを作成します。ZIPの中身: 投稿ごとのフォルダ（001, 002…）に投稿文.txtと画像（001_01.jpg…）、全体の投稿一覧.csvと確認用一覧.html。コメント・レビュー履歴・AI提案などの社内情報は含まれません。</p>
      <div className="row wrap" role="radiogroup" aria-label="対象">
        {([['content', '投稿を選ぶ'], ['pack', 'コンテンツパック'], ['campaign', 'キャンペーン']] as [Mode, string][]).map(([m, l]) => (
          <label key={m} className="row"><input type="radio" name="dp-mode" checked={mode === m} onChange={() => { setMode(m); setPreview(null); }} /> {l}</label>
        ))}
      </div>
      <Err e={a.error} />
      {mode === 'content' && (
        <Card title={`投稿を選択（${orderedSelection.length}件選択中）`} actions={<select aria-label="状態" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">すべての状態</option>{['draft', 'needs_review', 'approved', 'scheduled', 'published'].map((s) => <option key={s} value={s}>{s}</option>)}</select>}>
          {content.loading && !content.data ? <Loading /> : items.length === 0 ? <Empty>投稿がありません</Empty> : (
            <div className="table-wrap">
              <table className="table small">
                <thead><tr><th><input type="checkbox" aria-label="すべて選択" checked={items.length > 0 && orderedSelection.length === items.length} onChange={(e) => { setPreview(null); setSelected(e.target.checked ? items.map((c: any) => c.id) : []); }} /></th><th>Platform</th><th>内容</th><th>状態</th><th>投稿日時</th></tr></thead>
                <tbody>
                  {items.map((c: any) => (
                    <tr key={c.id}>
                      <td><input type="checkbox" aria-label={`選択 ${(c.title ?? c.body).slice(0, 20)}`} checked={selected.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} /></td>
                      <td><PlatformBadge p={c.platform} /></td>
                      <td><Link to={`/content/${c.id}`}>{(c.title ?? c.body).slice(0, 60)}</Link></td>
                      <td><Status s={c.status} /></td>
                      <td>{c.scheduledAt || c.publishedAt ? fmtDate(c.scheduledAt ?? c.publishedAt) : '未設定'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Err e={content.error} />
        </Card>
      )}
      {mode === 'pack' && (
        <Card title="コンテンツパックを選択">
          <select aria-label="コンテンツパック" value={packId} onChange={(e) => { setPackId(e.target.value); setPreview(null); }}>
            <option value="">選択…</option>
            {(packs.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{fmtDate(p.createdAt)}・{p.itemCount}件</option>)}
          </select>
        </Card>
      )}
      {mode === 'campaign' && (
        <Card title="キャンペーンを選択">
          <select aria-label="キャンペーン" value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setPreview(null); }}>
            <option value="">選択…</option>
            {(campaigns.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Card>
      )}
      <div className="row wrap">
        <button className="btn" disabled={!ready || a.busy} onClick={async () => setPreview(await a.run(() => api.post('/delivery-pack/preview', sel)))}>内容を確認</button>
        <button className="btn primary" disabled={!ready || a.busy} onClick={() => download(deliveryZipUrl(sel))}>納品パックZIPをダウンロード</button>
      </div>
      {preview && (
        <Card title={`${preview.folderName}.zip（${preview.posts.length}投稿・日時は ${preview.timezone}）`}>
          {preview.posts.some((p: any) => p.warnings.length) && <Notice kind="warn">確認が必要な投稿があります（このまま作成することもできます）。</Notice>}
          <div className="table-wrap">
            <table className="table small delivery-preview">
              <thead><tr><th>投稿番号</th><th>投稿日</th><th>投稿時間</th><th>管理タイトル</th><th>画像</th><th>確認</th></tr></thead>
              <tbody>
                {preview.posts.map((p: any) => (
                  <tr key={p.contentId}>
                    <td><Link to={`/content/${p.contentId}`}>{p.no}</Link></td>
                    <td>{p.date || '未設定'}</td>
                    <td>{p.time || '—'}</td>
                    <td>{p.title}</td>
                    <td>{p.images}枚</td>
                    <td>{p.warnings.map((w: string) => <span key={w} className="tag">{w}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">画像はJPG/PNG/WEBPのみ・1投稿10枚まで（投稿の編集画面の「メディア」で追加した画像が対象）。元画像は再圧縮せずそのまま格納します。</p>
        </Card>
      )}
    </div>
  );
}
