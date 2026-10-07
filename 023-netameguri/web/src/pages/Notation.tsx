// NetaMeguri 表記ゆれチェック: dictionary management page + per-draft panel (used in ContentEditor).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Card, Empty, Err, Loading, Notice, PLATFORM_LABEL, Status, useAction, useLoad, download, FilePick } from '../ui';

const MODE_LABEL: Record<string, string> = { string: '文字列一致', word: '単語一致' };

export function NotationPage() {
  const { workspace } = useSession();
  const canEdit = ['owner', 'admin'].includes(workspace.role);
  const { data: d, error, loading, setData } = useLoad(() => api.get('/notation/dictionary'));
  const scan = useLoad(() => api.get('/notation/scan'));
  const [form, setForm] = useState({ correct: '', variants: '', caseSensitive: true, matchMode: 'string' });
  const [importErr, setImportErr] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');
  const a = useAction();
  const done = (r: any, m: string) => {
    if (!r) return;
    setData(r.dictionary ?? r);
    setMsg(m);
    scan.reload();
  };
  if (loading && !d) return <Loading />;
  if (error) return <Err e={error} />;
  return (
    <div className="page">
      <h1>NetaMeguri 表記ゆれチェック</h1>
      <p className="muted">Workspace共通の表記ルール（正しい表記＋別表記）を登録し、下書きの表記ゆれを検出・置換します。正しい表記は利用者が決めます（自動の校正・正誤判断はしません）。全角/半角などの正規化は行わず、登録した文字列と完全に一致した箇所だけを検出します。</p>
      {msg && <Notice kind="ok">{msg}</Notice>}
      <Err e={a.error} />
      <div className="grid2">
        <Card title={`辞書: ${d.name}（${d.rules.length}ルール）`} actions={<button className="btn sm" onClick={() => download(api.url('/notation/export.json'))}>JSONを書き出し</button>}>
          {d.conflicts.length > 0 && (
            <Notice kind="warn">
              競合するルールがあります（該当箇所は検出しますが置換できません）:
              <ul className="list">{d.conflicts.map((c: any, i: number) => <li key={i}>「{c.variant}」→ {c.corrects.join(' / ')}</li>)}</ul>
            </Notice>
          )}
          {d.rules.length === 0 ? <Empty>ルールがまだありません。</Empty> : (
            <div className="table-wrap"><table className="table small notation-rules">
              <thead><tr><th>正しい表記</th><th>別表記</th><th>設定</th><th>有効</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {d.rules.map((r: any) => (
                  <tr key={r.ruleId}>
                    <td><b>{r.correct}</b></td>
                    <td>{r.variants.join('、')}{r.warnings.length > 0 && <div className="small muted">⚠ {r.warnings.join(' ')}</div>}</td>
                    <td>{MODE_LABEL[r.matchMode]}・{r.caseSensitive ? '大小区別' : '大小無視'}</td>
                    <td><input type="checkbox" aria-label={`${r.correct}を有効にする`} checked={r.enabled} disabled={!canEdit || a.busy} onChange={async (e) => done(await a.run(() => api.patch(`/notation/rules/${encodeURIComponent(r.ruleId)}`, { enabled: e.target.checked })), '更新しました')} /></td>
                    {canEdit && <td><button className="btn sm" disabled={a.busy} onClick={async () => { if (confirm(`「${r.correct}」のルールを削除しますか？`)) done(await a.run(() => api.del(`/notation/rules/${encodeURIComponent(r.ruleId)}`)), '削除しました'); }}>削除</button></td>}
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {!canEdit && <p className="small muted">辞書の編集はOwner/Adminのみ可能です。</p>}
        </Card>
        {canEdit && (
          <Card title="ルールを追加">
            <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await a.run(() => api.post('/notation/rules', form)); if (r) { done(r, `「${form.correct}」を追加しました`); setForm({ ...form, correct: '', variants: '' }); } }}>
              <label>正しい表記<input value={form.correct} onChange={(e) => setForm({ ...form, correct: e.target.value })} required maxLength={200} placeholder="例: YouTube" /></label>
              <label>別表記（1行に1つ）<textarea rows={4} value={form.variants} onChange={(e) => setForm({ ...form, variants: e.target.value })} required placeholder={'Youtube\nyoutube'} /></label>
              <div className="row wrap">
                <label>一致方式<select value={form.matchMode} onChange={(e) => setForm({ ...form, matchMode: e.target.value })}><option value="string">文字列一致（部分一致）</option><option value="word">単語一致（英数字の単語境界）</option></select></label>
                <label className="row"><input type="checkbox" checked={form.caseSensitive} onChange={(e) => setForm({ ...form, caseSensitive: e.target.checked })} /> 大文字小文字を区別</label>
              </div>
              <button className="btn primary" disabled={a.busy}>追加</button>
            </form>
            <hr />
            <FilePick label="辞書JSONを読み込む（現在の辞書を置き換え）" accept=".json,application/json" onFile={async (f) => {
              if (!f) return;
              setImportErr(null);
              const json = await f.text();
              if (d.rules.length && !confirm(`現在の辞書（${d.rules.length}ルール）を置き換えます。よろしいですか？`)) return;
              try {
                const r = await api.post('/notation/import', { json });
                done(r, `読み込みました（${r.rules.length}ルール）`);
              } catch (e: any) {
                setImportErr(e?.details?.errors ?? [e?.message ?? '読み込めませんでした']);
              }
            }} />
            {importErr && <Notice kind="err">辞書ファイルを読み込めませんでした。現在の辞書はそのままです。<ul className="list">{importErr.slice(0, 10).map((m) => <li key={m}>{m}</li>)}</ul></Notice>}
            <p className="small muted">表記ゆれチェッカー（単体版）で保存した辞書JSON（schemaVersion 1）をそのまま読み込めます。</p>
          </Card>
        )}
      </div>
      <Card title="下書きの表記ゆれ" actions={<button className="btn sm" onClick={() => scan.reload()}>再スキャン</button>}>
        {scan.loading && !scan.data ? <Loading /> : scan.data && (
          scan.data.items.length === 0 ? <p className="ok-t small">{scan.data.scanned}件の下書き・レビュー中・承認済み・予約済みの投稿に、登録ルールに違反する表記は見つかりませんでした。</p> : (
            <div className="table-wrap"><table className="table small">
              <thead><tr><th>投稿</th><th>状態</th><th>検出</th><th>例</th></tr></thead>
              <tbody>
                {scan.data.items.map((it: any) => (
                  <tr key={it.contentId}>
                    <td><Link to={`/content/${it.contentId}?tab=notation`}>{PLATFORM_LABEL[it.platform] ?? it.platform} {it.title ?? it.contentId.slice(0, 12)}</Link></td>
                    <td><Status s={it.status} /></td>
                    <td>{it.hits}件{it.conflicts ? `（競合${it.conflicts}）` : ''}</td>
                    <td>{it.sample.join(' / ')}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )
        )}
        <Err e={scan.error} />
      </Card>
    </div>
  );
}

/** Panel inside the draft editor: list hits with context, replace one / replace all of a form / ignore. */
export function NotationPanel({ contentId, version, disabled, onChanged }: { contentId: string; version: number; disabled: string | null; onChanged: () => void }) {
  const [res, setRes] = useState<any>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const a = useAction();
  const check = async (keys = ignored) => {
    const r = await a.run(() => api.post(`/content/${contentId}/notation/check`, { ignoredKeys: keys }));
    if (r) setRes(r);
  };
  const replace = async (payload: any) => {
    const r = await a.run(() => api.post(`/content/${contentId}/notation/replace`, { ...payload, ignoredKeys: ignored, expectedVersion: version }));
    if (!r) return;
    // keep ignore keys in sync with shifted positions
    const keys = r.findings.filter((f: any) => f.status === 'ignored').map((f: any) => f.key);
    setIgnored(keys);
    setRes(r);
    setMsg(`${r.replaced}件を置換しました（v${r.version}）${r.reReviewRequired ? '。承認後の変更のため再レビューが必要です' : ''}`);
    onChanged();
  };
  const toggleIgnore = (key: string, on: boolean) => {
    const keys = on ? [...ignored, key] : ignored.filter((k) => k !== key);
    setIgnored(keys);
    check(keys);
  };
  return (
    <Card title="NetaMeguri 表記ゆれチェック" actions={<><button className="btn sm" disabled={a.busy} onClick={() => check()}>{res ? '再チェック' : 'チェックする'}</button><Link className="small" to="/notation">辞書</Link></>}>
      <Err e={a.error} />
      {msg && <Notice kind="ok">{msg}</Notice>}
      {disabled && res && <Notice kind="warn">{disabled}</Notice>}
      {!res ? <p className="small muted">Workspaceの表記ゆれ辞書で本文をチェックします。</p> : (
        <div className="stack">
          <p className="small">有効ルール {res.enabledRules ?? '—'}件・検出 {res.counts.total}件（未修正 {res.counts.pending} ／ 置換済み {res.counts.replaced} ／ 無視 {res.counts.ignored}{res.counts.conflict ? ` ／ うち競合 ${res.counts.conflict}` : ''}）</p>
          {res.counts.total === 0 && <p className="ok-t small">登録ルールに違反する表記は見つかりませんでした。</p>}
          {res.groups.length > 0 && (
            <ul className="list">
              {res.groups.map((g: any) => (
                <li key={g.matched + g.correct} className="row between wrap">
                  <span><s>{g.matched}</s> → <b>{g.correct}</b>：{g.total}件{g.pending !== g.total ? `（未修正 ${g.pending}）` : ''}</span>
                  {g.conflict ? <span className="tag">競合する辞書ルール（置換不可）</span> : <button className="btn sm" disabled={!!disabled || a.busy || g.pending === 0} onClick={() => { if (confirm(`「${g.matched}」を「${g.correct}」へ ${g.pending}件置換します（無視した箇所は対象外）。`)) replace({ mode: 'group', matched: g.matched, correct: g.correct }); }}>この表記をすべて置換</button>}
                </li>
              ))}
            </ul>
          )}
          {res.findings.length > 0 && (
            <div className="table-wrap"><table className="table small notation-hits">
              <thead><tr><th>行</th><th>前後文</th><th>正しい表記</th><th>状態</th><th /></tr></thead>
              <tbody>
                {res.findings.map((f: any) => (
                  <tr key={f.key + f.status}>
                    <td>{f.lineNo}</td>
                    <td>{f.context.before}<mark>{f.context.target}</mark>{f.context.after}</td>
                    <td>{f.correct}</td>
                    <td>{f.status === 'replaced' ? '置換済み' : f.status === 'ignored' ? '無視' : f.conflict ? '未修正（競合）' : '未修正'}</td>
                    <td className="row">
                      {f.status === 'pending' && !f.conflict && <button className="btn sm" disabled={!!disabled || a.busy} onClick={() => replace({ mode: 'one', key: f.key })}>置換</button>}
                      {f.status === 'pending' && <button className="btn sm" disabled={a.busy} onClick={() => toggleIgnore(f.key, true)}>無視</button>}
                      {f.status === 'ignored' && <button className="btn sm" disabled={a.busy} onClick={() => toggleIgnore(f.key, false)}>無視を解除</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <p className="small muted">置換は新しい版として保存されます（履歴から戻せます）。「無視」はこの画面を開いている間だけ保持されます。</p>
        </div>
      )}
    </Card>
  );
}
