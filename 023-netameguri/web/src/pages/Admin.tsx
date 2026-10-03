import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, Err, Loading, Notice, PLATFORM_LABEL, Status, fmtDate, useAction, useLoad, download, JaTime, FilePick, TzSelect, CAP_LABEL } from '../ui';
import { offlineQueue, useOnline, useSession, flushOffline } from '../App';

// ---------------------------------------------------------------- Brand

export function BrandPage() {
  const { data: brands, error, loading, reload } = useLoad(() => api.get('/brands'));
  const [b, setB] = useState<any>(null);
  const [samples, setSamples] = useState('');
  const a = useAction();
  useEffect(() => {
    if (brands?.length && !b) setB(brands[0]);
  }, [brands]);
  if (loading && !brands) return <Loading />;
  if (error) return <Err e={error} />;
  const list = (s: string) => s.split(/[\n,、]/).map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    const payload = { ...b, preferredTerms: typeof b.preferredTerms === 'string' ? list(b.preferredTerms) : b.preferredTerms, bannedTerms: typeof b.bannedTerms === 'string' ? list(b.bannedTerms) : b.bannedTerms, bannedCtas: typeof b.bannedCtas === 'string' ? list(b.bannedCtas) : b.bannedCtas };
    for (const k of ['id', 'createdAt', 'updatedAt', 'voiceStatus', 'voiceDraft']) delete payload[k];
    const r = b.id ? await a.run(() => api.patch(`/brands/${b.id}`, payload)) : await a.run(() => api.post('/brands', payload));
    if (r) {
      setB(r);
      reload();
    }
  };
  if (!b) {
    return (
      <div className="page narrow">
        <h1>Brand Voice</h1>
        <Empty>まだBrandがありません。</Empty>
        <button className="btn primary" onClick={() => setB({ name: '', language: 'ja', emojiPolicy: 'few', maxEmoji: 2, hashtagsPolicy: 'minimal', bannedTerms: [], preferredTerms: [], bannedCtas: [], aiEligible: true })}>Brandを作成</button>
      </div>
    );
  }
  const txt = (v: any) => (Array.isArray(v) ? v.join('\n') : v ?? '');
  return (
    <div className="page">
      <div className="hero">
        <h1>Brand Voice</h1>
        {brands.length > 1 && <select value={b.id} onChange={(e) => setB(brands.find((x: any) => x.id === e.target.value))} aria-label="Brand">{brands.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      </div>
      <div className="grid2">
        <Card title="基本">
          <div className="stack">
            <label>名前<input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></label>
            <label>説明<textarea rows={2} value={b.description ?? ''} onChange={(e) => setB({ ...b, description: e.target.value })} /></label>
            <label>対象読者<input value={b.audience ?? ''} onChange={(e) => setB({ ...b, audience: e.target.value })} /></label>
            <label>ポジショニング<input value={b.positioning ?? ''} onChange={(e) => setB({ ...b, positioning: e.target.value })} /></label>
            <label>言語<select value={b.language} onChange={(e) => setB({ ...b, language: e.target.value })}><option value="ja">日本語</option><option value="en">English</option></select></label>
          </div>
        </Card>
        <Card title="文体">
          <div className="stack">
            <label>Voiceの要約<textarea rows={3} value={b.voiceSummary ?? ''} onChange={(e) => setB({ ...b, voiceSummary: e.target.value })} /></label>
            <label>トーン<input value={b.tone ?? ''} onChange={(e) => setB({ ...b, tone: e.target.value })} /></label>
            <label>文の書き方<input value={b.sentenceStyle ?? ''} onChange={(e) => setB({ ...b, sentenceStyle: e.target.value })} /></label>
            <label>CTAの方針（「」で囲むとそのまま使用）<input value={b.ctaStyle ?? ''} onChange={(e) => setB({ ...b, ctaStyle: e.target.value })} /></label>
            <div className="grid2 tight">
              <label>絵文字<select value={b.emojiPolicy} onChange={(e) => setB({ ...b, emojiPolicy: e.target.value })}><option value="none">使わない</option><option value="few">少なめ</option><option value="free">自由</option></select></label>
              <label>絵文字の上限<input type="number" min={0} max={30} value={b.maxEmoji} onChange={(e) => setB({ ...b, maxEmoji: Number(e.target.value) })} /></label>
              <label>ハッシュタグ<select value={b.hashtagsPolicy} onChange={(e) => setB({ ...b, hashtagsPolicy: e.target.value })}><option value="none">使わない</option><option value="minimal">最小限</option><option value="standard">標準</option></select></label>
            </div>
          </div>
        </Card>
        <Card title="用語">
          <div className="stack">
            <label>推奨用語（改行区切り）<textarea rows={3} value={txt(b.preferredTerms)} onChange={(e) => setB({ ...b, preferredTerms: e.target.value })} /></label>
            <label>禁止表現（Brand Guardでブロック）<textarea rows={3} value={txt(b.bannedTerms)} onChange={(e) => setB({ ...b, bannedTerms: e.target.value })} /></label>
            <label>禁止CTA<textarea rows={2} value={txt(b.bannedCtas)} onChange={(e) => setB({ ...b, bannedCtas: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={b.aiEligible} onChange={(e) => setB({ ...b, aiEligible: e.target.checked })} />このBrandのデータを外部AIへ送信してよい</label>
          </div>
        </Card>
        <Card title="過去の文章からVoiceのDraftを作る">
          <p className="small muted">過去投稿・記事・商品説明などを貼り付けると、トーン・文の長さ・丁寧さ・絵文字・CTAの傾向をDraftします。保存前に必ず人間が確認します。本人の文体の完全再現は保証しません。</p>
          <textarea rows={5} value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="1件ごとに空行で区切って貼り付け" aria-label="サンプル" />
          <button className="btn" disabled={!samples || a.busy || !b.id} onClick={async () => { await a.run(() => api.post(`/brands/${b.id}/voice-draft`, { samples: samples.split(/\n\s*\n/).filter(Boolean) })); reload().then(() => undefined); const nb = await api.get(`/brands/${b.id}`); setB(nb); }}>Draftを作成</button>
          {b.voiceDraft && (
            <div className="stack">
              <dl className="kv">
                <dt>トーン</dt><dd>{b.voiceDraft.tone}</dd><dt>丁寧さ</dt><dd>{b.voiceDraft.formality}</dd><dt>平均文長</dt><dd>{b.voiceDraft.avgSentenceLength}文字</dd>
                <dt>絵文字/投稿</dt><dd>{b.voiceDraft.emojiPerPost}</dd><dt>頻出語</dt><dd>{b.voiceDraft.frequentPhrases.join('、')}</dd>
              </dl>
              {b.voiceDraft.aiSummary && <p className="small">{b.voiceDraft.aiSummary}</p>}
              <p className="small muted">{b.voiceDraft.note}</p>
              <button className="btn sm" onClick={async () => { const r = await a.run(() => api.post(`/brands/${b.id}/voice-confirm`, { voiceSummary: b.voiceSummary || `${b.voiceDraft.tone}・${b.voiceDraft.formality}・平均${b.voiceDraft.avgSentenceLength}文字`, tone: b.tone || b.voiceDraft.tone })); if (r) setB(r); }}>確認して保存</button>
            </div>
          )}
          <p className="small">状態: {b.voiceStatus}</p>
        </Card>
      </div>
      <Err e={a.error} />
      <button className="btn primary" disabled={a.busy} onClick={save}>保存</button>
    </div>
  );
}

// ---------------------------------------------------------------- Claims

export function ClaimsPage() {
  const { data, error, loading, reload } = useLoad(() => api.get('/claims'));
  const [f, setF] = useState({ key: '', label: '', value: '', source: '' });
  const a = useAction();
  const [flag, setFlag] = useState<any>(null);
  return (
    <div className="page">
      <h1>Claim Registry</h1>
      <p className="muted">価格・機能・実績・会社情報など、間違えると危険な事実を登録します。古い値が投稿案で使われると警告します。verified（確認済み）は人間だけが設定できます。</p>
      {loading && <Loading />}
      <Err e={error} />
      {data && (data.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>項目</th><th>現在の値</th><th>出典</th><th>確認</th><th>履歴</th><th></th></tr></thead>
            <tbody>
              {data.map((c: any) => (
                <tr key={c.id}>
                  <td>{c.label}<div className="small muted">{c.key}</div></td>
                  <td><b>{c.value}</b><div className="small muted">{c.validFrom?.slice(0, 10)}〜{c.validTo?.slice(0, 10) ?? ''}</div></td>
                  <td className="small">{c.source}</td>
                  <td>{c.verifiedAt ? <span className="ok-t small">確認済み {fmtDate(c.verifiedAt)}</span> : <button className="btn sm" onClick={async () => { await a.run(() => api.post(`/claims/${c.id}/verify`, {})); reload(); }}>確認済みにする</button>}</td>
                  <td className="small">{c.history.map((h: any) => `${h.value}（〜${h.validTo?.slice(0, 10)}）`).join(' / ')}</td>
                  <td><button className="btn sm" onClick={async () => { const v = prompt(`「${c.label}」の新しい値`, c.value); if (v && v !== c.value) { const r = await a.run(() => api.post(`/claims/${c.id}/value`, { value: v })); if (r) setFlag(r.flagged); reload(); } }}>値を更新</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>まだ登録がありません</Empty>)}
      {flag && <Notice kind="warn">古い値を含むIdea {flag.ideas.length}件・Content {flag.contents.length}件を「要更新/再レビュー」にしました。</Notice>}
      <Card title="追加">
        <form className="grid2 tight" onSubmit={async (e) => { e.preventDefault(); await a.run(() => api.post('/claims', f)); setF({ key: '', label: '', value: '', source: '' }); reload(); }}>
          <label>キー<input required value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="product.price" /></label>
          <label>名前<input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="月額料金" /></label>
          <label>値（本文に出てくる表記）<input required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="月額980円" /></label>
          <label>出典<input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
          <button className="btn primary" disabled={a.busy}>追加（未確認として登録）</button>
        </form>
        <Err e={a.error} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Connectors

const CAP_JA = CAP_LABEL;
const DOC_JA: Record<string, string> = { docs: '公式docsで可', conditional: '条件付き', unverified: '未確認', no: '公式APIなし' };

export function ConnectorsPage() {
  const { data, error, loading, reload } = useLoad(() => api.get('/connectors'));
  const [sp] = useSearchParams();
  const a = useAction();
  const { workspace } = useSession();
  if (loading && !data) return <Loading />;
  if (error) return <Err e={error} />;
  const connect = async (adapter: string) => {
    if (!confirm('Sandbox（シミュレーション）に接続します。実SNSアカウントには接続しません。')) return;
    const r = await a.run(() => api.post('/connectors/oauth/start', { adapter }));
    if (r) location.href = r.url;
  };
  return (
    <div className="page">
      <h1>SNS Connector</h1>
      <Notice kind="info">「投稿」できるかどうかは、公式APIの仕様と接続状態で決まります。APIがないPlatformは自動投稿できると表示しません。実SNSアカウントの接続・実投稿は、利用者が明示的に設定した場合のみ行われます。</Notice>
      {sp.get('connected') && <Notice kind="ok">接続しました。</Notice>}
      <Err e={a.error} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Platform</th><th>今できること</th><th>公式API（調査メモ）</th><th>接続</th></tr></thead>
          <tbody>
            {data.matrix.map((m: any) => (
              <tr key={m.platform}>
                <td><b>{m.label}</b>{m.unavailable && <div className="small err-t">公式APIで投稿不可</div>}</td>
                <td>{m.effective.map((c: string) => <span key={c} className={`tag cap-${c}`}>{CAP_JA[c]}</span>)}<div className="small muted">{m.autoPublish ? '自動投稿可' : '手動投稿（Export/Reminder）'}</div></td>
                <td className="small">{Object.entries(m.officialDocs).map(([k, v]) => `${CAP_JA[k]}: ${DOC_JA[v as string]}`).join(' / ') || '—'}<div className="muted">{m.conditions}</div><div className="muted">Scope: {m.scopes.publish.join(', ') || '—'}</div></td>
                <td>
                  {m.connectors.map((c: any) => (
                    <div key={c.id} className="small">
                      {c.adapterLabel} <Status s={c.status} />{c.simulated && <span className="tag">Sandbox</span>}
                      {c.tokenExpiresAt && <div className="muted">期限 {fmtDate(c.tokenExpiresAt)}</div>}
                      {c.status !== 'revoked' && ['owner', 'admin'].includes(workspace.role) && <button className="link" onClick={async () => { if (confirm('接続を解除し、トークンを削除します')) { await a.run(() => api.post(`/connectors/${c.id}/revoke`, {})); reload(); } }}>解除</button>}
                    </div>
                  ))}
                  {m.adapters.filter((x: any) => x.simulated).map((x: any) => <button key={x.id} className="btn sm" onClick={() => connect(x.id)}>Sandboxに接続</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">出典と確認日はSOURCE_NOTES.mdを参照してください。仕様は変わるため、リリース前に再確認が必要です。</p>
    </div>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsPage() {
  const { data, error, loading, reload } = useLoad(() => api.get(''));
  const { data: members, reload: reloadMembers } = useLoad(() => api.get('/members'));
  const { data: usage } = useLoad(() => api.get('/ai-usage'));
  const [s, setS] = useState<any>(null);
  const [tz, setTz] = useState('');
  const [m, setM] = useState({ email: '', role: 'editor', canPublishExternal: false });
  const a = useAction();
  useEffect(() => {
    if (data) {
      setS(data.settings);
      setTz(data.timezone);
    }
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <Err e={error} />;
  if (!s) return null;
  const r = s.reuseRules;
  const save = async () => {
    await a.run(() => api.patch('/settings', { ...s, timezone: tz }));
    reload();
  };
  return (
    <div className="page">
      <h1>設定</h1>
      <div className="grid2">
        <Card title="AI">
          <div className="stack">
            <label className="check"><input type="checkbox" checked={s.aiEnabled} onChange={(e) => setS({ ...s, aiEnabled: e.target.checked })} />AIを使う（OFFにすると外部AIへの送信は0件。抽出エンジンのみ）</label>
            <label>プロバイダ<select value={s.aiProvider} onChange={(e) => setS({ ...s, aiProvider: e.target.value })}><option value="local">ローカル抽出エンジン（外部送信なし）</option><option value="anthropic">Anthropic Claude（APIキーはサーバー環境変数）</option><option value="openai">OpenAI（APIキーはサーバー環境変数）</option></select></label>
            <label>モデル（任意）<input value={s.aiModel ?? ''} onChange={(e) => setS({ ...s, aiModel: e.target.value || null })} /></label>
            <label>月の上限（USD）<input type="number" min={0} value={s.aiMonthlyCostCapUsd} onChange={(e) => setS({ ...s, aiMonthlyCostCapUsd: Number(e.target.value) })} /></label>
            <label>ベクトル検索<select value={s.embeddingProvider} onChange={(e) => setS({ ...s, embeddingProvider: e.target.value })}><option value="local-hash">ローカル（語彙ベース近似）</option><option value="openai">OpenAI Embeddings</option><option value="off">OFF</option></select></label>
            {usage && <p className="small">今月の利用: ${usage.status.monthSpendUsd.toFixed(4)} / ${usage.status.capUsd}・プロバイダ設定: {usage.status.providerConfigured ? 'OK' : '未設定（環境変数にAPIキーが必要）'}</p>}
          </div>
        </Card>
        <Card title="承認・投稿">
          <div className="stack">
            <label className="check"><input type="checkbox" checked={s.requireApprovalBeforePublish} onChange={(e) => setS({ ...s, requireApprovalBeforePublish: e.target.checked })} />外部投稿・公開済み登録の前にApprovedを必須にする</label>
            <label className="check"><input type="checkbox" checked={s.reReviewOnEditAfterApproval} onChange={(e) => setS({ ...s, reReviewOnEditAfterApproval: e.target.checked })} />承認後に本文を変更したら再レビューにする</label>
            <label className="check"><input type="checkbox" checked={s.mcpPublishAllowed} onChange={(e) => setS({ ...s, mcpPublishAllowed: e.target.checked })} />ChatGPT/Claude等(MCP)からの投稿を許可（確認コード＋明示承認が必要）</label>
            <label className="check"><input type="checkbox" checked={s.storeOriginalMedia} onChange={(e) => setS({ ...s, storeOriginalMedia: e.target.checked })} />文字起こし後も元のメディアを保存する</label>
            <TzSelect label="タイムゾーン" value={tz} onChange={setTz} />
          </div>
        </Card>
        <Card title="再利用ルール（Reuse Rules）">
          <div className="grid2 tight">
            <label>同じPlatformで警告する期間（日）<input type="number" value={r.samePlatformWarnDays} onChange={(e) => setS({ ...s, reuseRules: { ...r, samePlatformWarnDays: Number(e.target.value) } })} /></label>
            <label>High Performerの再利用まで（日）<input type="number" value={r.highPerformerReuseDays} onChange={(e) => setS({ ...s, reuseRules: { ...r, highPerformerReuseDays: Number(e.target.value) } })} /></label>
            <label>再利用候補にするまで（日）<input type="number" value={r.recyclingCandidateAfterDays} onChange={(e) => setS({ ...s, reuseRules: { ...r, recyclingCandidateAfterDays: Number(e.target.value) } })} /></label>
            <label>最近使用とみなす期間（日）<input type="number" value={r.recentlyUsedDays} onChange={(e) => setS({ ...s, reuseRules: { ...r, recentlyUsedDays: Number(e.target.value) } })} /></label>
            <label>使いすぎの回数<input type="number" value={r.overusedThreshold} onChange={(e) => setS({ ...s, reuseRules: { ...r, overusedThreshold: Number(e.target.value) } })} /></label>
          </div>
          <p className="small muted">Needs Updateのネタは常に自動投稿禁止です。</p>
        </Card>
        <Card title="通知">
          <div className="grid2 tight">
            <JaTime label="静かな時間 開始" step={15} value={s.quietHours?.start ?? '22:00'} onChange={(v) => setS({ ...s, quietHours: { ...(s.quietHours ?? { end: '08:00' }), start: v } })} />
            <JaTime label="静かな時間 終了" step={15} value={s.quietHours?.end ?? '08:00'} onChange={(v) => setS({ ...s, quietHours: { ...(s.quietHours ?? { start: '22:00' }), end: v } })} />
            <label>1時間あたりの上限<input type="number" min={1} value={s.notificationMaxPerHour} onChange={(e) => setS({ ...s, notificationMaxPerHour: Number(e.target.value) })} /></label>
          </div>
        </Card>
      </div>
      <Err e={a.error} />
      <button className="btn primary" disabled={a.busy} onClick={save}>設定を保存</button>
      <Card title="メンバー">
        {members && (
          <table className="table"><thead><tr><th>名前</th><th>メール</th><th>役割</th><th>外部投稿</th></tr></thead><tbody>
            {members.map((x: any) => <tr key={x.id}><td>{x.name}</td><td>{x.email}</td><td>{x.role}</td><td>{x.can_publish_external ? '可' : '—'}</td></tr>)}
          </tbody></table>
        )}
        <form className="row wrap" onSubmit={async (e) => { e.preventDefault(); await a.run(() => api.post('/members', m)); reloadMembers(); }}>
          <input type="email" placeholder="登録済みユーザーのメール" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} aria-label="メール" required />
          <select value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })} aria-label="役割">{['admin', 'editor', 'reviewer', 'viewer'].map((x) => <option key={x}>{x}</option>)}</select>
          <label className="check"><input type="checkbox" checked={m.canPublishExternal} onChange={(e) => setM({ ...m, canPublishExternal: e.target.checked })} />外部投稿権限</label>
          <button className="btn">追加/更新</button>
        </form>
        <p className="small muted">外部投稿権限はEditorに自動付与されません。Owner/Adminが個別に付与します。</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Import / Export / Backup

export function DataPage() {
  const [csv, setCsv] = useState('');
  const [plat, setPlat] = useState('threads');
  const [prev, setPrev] = useState<any>(null);
  const [mapping, setMapping] = useState<any>({});
  const [result, setResult] = useState<any>(null);
  const [restore, setRestore] = useState<any>(null);
  const [utm, setUtm] = useState({ url: '', source: 'threads', campaign: '' });
  const [utmOut, setUtmOut] = useState('');
  const a = useAction();
  return (
    <div className="page">
      <h1>Import / Export / Backup</h1>
      <div className="grid2">
        <Card title="過去投稿をImport（CSV）">
          <p className="small muted">取り込み → プレビュー → 列の対応付け → 重複確認 → 確定。過去投稿からIdea Fingerprintを作り、新しいDraftとの重複を警告できるようにします。</p>
          <FilePick label="CSVファイル" accept=".csv,text/csv" onFile={async (f) => setCsv(f ? await f.text() : '')} />
          <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="platform,date,text,likes,views" aria-label="CSV" />
          <label>Platform列がない場合<select value={plat} onChange={(e) => setPlat(e.target.value)}>{Object.entries(PLATFORM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <button className="btn" disabled={!csv || a.busy} onClick={async () => { const r = await a.run(() => api.post('/import/preview', { csv, defaultPlatform: plat })); if (r) { setPrev(r); setMapping(r.mapping); setResult(null); } }}>プレビュー</button>
          {prev && (
            <div className="stack">
              <p className="small">{prev.rowCount}行</p>
              <div className="grid2 tight">
                {['text', 'platform', 'publishedAt', 'url', 'likes', 'views', 'impressions', 'comments', 'shares', 'saves', 'clicks'].map((k) => (
                  <label key={k}>{k}<select value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value || null })}><option value="">（なし）</option>{prev.headers.map((h: string) => <option key={h}>{h}</option>)}</select></label>
                ))}
              </div>
              <table className="table small"><thead><tr><th>Platform</th><th>日付</th><th>本文</th><th>重複</th></tr></thead><tbody>
                {prev.preview.map((r: any, i: number) => <tr key={i}><td className={r.platformValid ? '' : 'err-t'}>{r.platform}</td><td>{r.publishedAt}</td><td>{r.text}</td><td>{r.exactDuplicate ? '取込済み' : r.similarIdea ? r.similarIdea.message : '—'}</td></tr>)}
              </tbody></table>
              <button className="btn primary" disabled={a.busy} onClick={async () => setResult(await a.run(() => api.post(`/import/${prev.batchId}/confirm`, { mapping, defaultPlatform: plat })))}>確定</button>
            </div>
          )}
          {result && <Notice kind="ok">作成 {result.created}件・スキップ {result.skipped}件・エラー {result.errors.length}件{result.errors.length ? `（${result.errors.slice(0, 3).map((e: any) => `${e.row}行目: ${e.error}`).join(' / ')}）` : ''}</Notice>}
        </Card>
        <Card title="Export">
          <div className="row wrap">
            {['csv', 'json', 'md', 'txt'].map((f) => <button key={f} className="btn sm" onClick={() => download(api.url(`/export/content?format=${f}`))}>{f.toUpperCase()}</button>)}
            <button className="btn sm" onClick={() => download(api.url('/export/copy-package.zip'))}>Platform別コピー用ZIP</button>
          </div>
          <p className="small muted">CSVは表計算ソフトの数式インジェクション対策済みです。Content Pack ZIPとCampaignカレンダーは各画面から書き出せます。</p>
        </Card>
        <Card title="Backup / Restore">
          <button className="btn" onClick={() => download(api.url('/backup.zip'))}>Workspaceをバックアップ</button>
          <p className="small muted">schemaVersion / appVersion / checksum付き。Connectorのトークンは含みません（復元後に再接続）。メディアファイルは別途（オブジェクトストレージ）バックアップしてください。</p>
          <FilePick label="空のWorkspaceへ復元" accept=".zip,application/zip" onFile={async (f) => { if (!f) return; setRestore(await a.run(() => api.post('/restore', f))); }} />
          {restore && <Notice kind="ok">復元しました: {Object.entries(restore.restored).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${k} ${v}`).join(', ')}</Notice>}
        </Card>
        <Card title="UTMリンク作成">
          <div className="stack">
            <input type="url" placeholder="https://" value={utm.url} onChange={(e) => setUtm({ ...utm, url: e.target.value })} aria-label="URL" />
            <div className="row"><input value={utm.source} onChange={(e) => setUtm({ ...utm, source: e.target.value })} aria-label="source" /><input value={utm.campaign} placeholder="campaign" onChange={(e) => setUtm({ ...utm, campaign: e.target.value })} aria-label="campaign" /></div>
            <button className="btn sm" disabled={!utm.url} onClick={async () => { const r = await a.run(() => api.post('/utm', utm)); if (r) setUtmOut(r.url); }}>作成</button>
            {utmOut && <code className="break">{utmOut}</code>}
          </div>
        </Card>
      </div>
      <Err e={a.error} />
    </div>
  );
}

export function AuditPage() {
  const { data, error, loading } = useLoad(() => api.get('/audit'));
  return (
    <div className="page">
      <h1>監査ログ</h1>
      {loading && <Loading />}
      <Err e={error} />
      {data && (
        <div className="table-wrap"><table className="table small"><thead><tr><th>日時</th><th>操作者</th><th>操作</th><th>対象</th><th>詳細</th></tr></thead><tbody>
          {data.map((x: any) => <tr key={x.id}><td>{fmtDate(x.created_at)}</td><td>{x.actor_name ?? 'system'}</td><td>{x.action}</td><td>{x.target_type} {x.target_id?.slice(0, 14)}</td><td className="break">{x.meta}</td></tr>)}
        </tbody></table></div>
      )}
      <p className="small muted">本文や秘密情報は記録しません。</p>
    </div>
  );
}

// ---------------------------------------------------------------- Inbox / Quick Capture

export function InboxPage() {
  const { workspace } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.get('/inbox'));
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const online = useOnline();
  const a = useAction();
  const capture = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { text: text || undefined, url: url || undefined };
    if (!navigator.onLine) {
      offlineQueue.enqueue({ kind: 'capture', workspaceId: workspace.id, payload });
      setMsg('オフラインのため端末に保存しました（未同期）。接続時に送信されます。');
    } else {
      const r = await a.run(() => api.post('/inbox', payload));
      if (!r) return;
      setMsg('Inboxに追加しました');
      reload();
    }
    setText('');
    setUrl('');
  };
  const pending = offlineQueue.pending();
  return (
    <div className="page narrow">
      <h1>Quick Capture</h1>
      <form className="card stack" onSubmit={capture}>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="思いついたネタ・メモ" aria-label="メモ" />
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL（任意）" aria-label="URL" />
        <button className="btn primary" disabled={!text && !url}>Inboxに入れる</button>
        {msg && <p className="small ok-t" role="status">{msg}</p>}
        {!online && <p className="small warn-t">オフラインです。メモは端末に保存されます。</p>}
      </form>
      {pending.length > 0 && (
        <Card title={`未同期 ${pending.length}件`} actions={<button className="btn sm" disabled={!online} onClick={async () => { await flushOffline(); reload(); setMsg('同期しました'); }}>今すぐ同期</button>}>
          <ul className="list">{pending.map((p) => <li key={p.clientId}>{p.kind === 'capture' ? String(p.payload.text ?? p.payload.url ?? '') : `Draft編集 ${p.contentId}`}{p.conflict && <span className="err-t small"> 競合（確認が必要）</span>}</li>)}</ul>
        </Card>
      )}
      <Err e={error ?? a.error} />
      {loading && <Loading />}
      <Card title="未整理のInbox">
        {data?.length ? (
          <ul className="list">
            {data.map((it: any) => (
              <li key={it.id}>
                <div>{it.text ?? it.url}</div>
                <div className="small muted">提案: {it.suggestion?.action === 'idea' ? 'Ideaにする' : `Source（${it.suggestion?.sourceType}）にする`} — {it.suggestion?.reason}</div>
                <div className="row wrap">
                  <button className="btn sm" onClick={async () => { await a.run(() => api.post(`/inbox/${it.id}/process`, { action: 'idea' })); reload(); }}>Ideaにする</button>
                  <button className="btn sm" onClick={async () => { await a.run(() => api.post(`/inbox/${it.id}/process`, { action: 'source', sourceType: it.suggestion?.sourceType, fetchUrl: !!it.url })); reload(); }}>Sourceにする</button>
                  <button className="btn sm ghost" onClick={async () => { await a.run(() => api.post(`/inbox/${it.id}/process`, { action: 'discard' })); reload(); }}>破棄</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty>未整理のメモはありません</Empty>}
        <p className="small muted">AIの分類は提案です。人間が確認してから処理します。</p>
      </Card>
      <p className="small muted">Android（Chrome）ではホーム画面に追加すると「共有」からNetaMeguriへ送れます。iPhoneは共有ターゲット非対応のため、このページにコピー&ペーストしてください。</p>
      <Link to="/">ダッシュボードへ</Link>
    </div>
  );
}

/** PWA share_target landing (Android). Pre-fills a capture; the user confirms. */
export function SharePage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const a = useAction();
  const { workspace } = useSession();
  const text = [sp.get('title'), sp.get('text')].filter(Boolean).join('\n');
  const url = sp.get('url') ?? (text.match(/https?:\/\/\S+/)?.[0] ?? '');
  return (
    <div className="page narrow">
      <h1>共有から追加</h1>
      <Card>
        <p>{text || '（テキストなし）'}</p>
        {url && <p className="small">{url}</p>}
        <button className="btn primary" disabled={a.busy} onClick={async () => {
          const payload = { text: text || undefined, url: url || undefined };
          if (!navigator.onLine) offlineQueue.enqueue({ kind: 'capture', workspaceId: workspace.id, payload });
          else await a.run(() => api.post('/inbox', payload));
          nav('/inbox');
        }}>Inboxに追加</button>
        <Err e={a.error} />
      </Card>
    </div>
  );
}
