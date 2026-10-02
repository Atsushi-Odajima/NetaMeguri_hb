import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, request, setSession, setWorkspace, savedWorkspace, getWorkspace } from './api';
import { Logo, Err, useAction, Loading } from './ui';
import { OfflineQueue, LocalStorageKV } from './offline';
import { Dashboard } from './pages/Dashboard';
import { SourcesPage, SourceDetail, NewSource } from './pages/Sources';
import { IdeasPage, IdeaDetail } from './pages/Ideas';
import { PackDetail, ContentEditor, ReviewQueue, ContentList } from './pages/Content';
import { CampaignsPage, CampaignDetail, CalendarPage } from './pages/Campaigns';
import { LibraryPage, StrategistPage, PerformancePage, RecyclingPage } from './pages/Insights';
import { BrandPage, ClaimsPage, ConnectorsPage, SettingsPage, DataPage, AuditPage, InboxPage, SharePage } from './pages/Admin';

interface Session {
  user: { id: string; email: string; name: string };
  workspaces: { id: string; name: string; role: string; is_sample: number; timezone: string }[];
}
const SessionCtx = createContext<{ session: Session; workspace: Session['workspaces'][number]; reloadSession: () => Promise<void>; switchWs: (id: string) => void } | null>(null);
export const useSession = () => useContext(SessionCtx)!;

export const offlineQueue = new OfflineQueue(new LocalStorageKV());

export function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => {
      window.removeEventListener('online', a);
      window.removeEventListener('offline', b);
    };
  }, []);
  return on;
}

export async function flushOffline() {
  return offlineQueue.flush(async (item) => {
    try {
      const ws = item.workspaceId ?? getWorkspace();
      if (item.kind === 'capture') await request('POST', `/api/w/${ws}/inbox`, { ...item.payload, clientId: item.clientId });
      else await request('PATCH', `/api/w/${ws}/content/${item.contentId}`, item.payload);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, conflict: e?.status === 409, error: e?.message };
    }
  });
}

const NAV: { to: string; label: string; icon: string; mobile?: boolean }[] = [
  { to: '/', label: 'ダッシュボード', icon: '⌂', mobile: true },
  { to: '/sources', label: '素材 (Source)', icon: '▤', mobile: true },
  { to: '/ideas', label: 'ネタ (Idea)', icon: '✦' },
  { to: '/content', label: 'コンテンツ', icon: '✎' },
  { to: '/review', label: 'レビュー', icon: '✓' },
  { to: '/calendar', label: 'カレンダー', icon: '▦', mobile: true },
  { to: '/campaigns', label: 'キャンペーン', icon: '⚑' },
  { to: '/library', label: 'ライブラリ検索', icon: '⌕' },
  { to: '/strategist', label: 'AIアシスタント', icon: '◎' },
  { to: '/performance', label: '効果分析', icon: '▮' },
  { to: '/recycling', label: '再利用', icon: '↻' },
  { to: '/inbox', label: 'Quick Capture', icon: '+', mobile: true },
  { to: '/brand', label: 'Brand Voice', icon: '❝' },
  { to: '/claims', label: 'Claim Registry', icon: '§' },
  { to: '/connectors', label: 'SNS Connector', icon: '⇄' },
  { to: '/data', label: 'Import/Export', icon: '⇩' },
  { to: '/settings', label: '設定', icon: '⚙' },
  { to: '/audit', label: '監査ログ', icon: '☰' },
];

function Shell({ children }: { children: ReactNode }) {
  const { session, workspace, switchWs } = useSession();
  const [open, setOpen] = useState(false);
  const online = useOnline();
  const loc = useLocation();
  const nav = useNavigate();
  const [pending, setPending] = useState(offlineQueue.pending().length);
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const t = setInterval(() => setPending(offlineQueue.pending().length), 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (online && offlineQueue.pending().length) flushOffline().then(() => setPending(offlineQueue.pending().length));
  }, [online]);
  const logout = async () => {
    await request('POST', '/api/auth/logout', {});
    // drop cached API responses so the next user on this device cannot see them
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
    location.href = '/login';
  };
  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="side-h">
          <Logo size={22} />
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'on' : '')}>
              <span className="ni" aria-hidden>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-f">
          <label className="small">Workspace</label>
          <select value={workspace.id} onChange={(e) => switchWs(e.target.value)} aria-label="Workspace">
            {session.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.is_sample ? '（サンプル）' : ''}
              </option>
            ))}
          </select>
          <div className="small muted">{session.user.name}・{workspace.role}</div>
          <button className="link" onClick={logout}>ログアウト</button>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="top">
          <button className="hamb" aria-label="メニュー" onClick={() => setOpen(!open)}>☰</button>
          <span className="top-logo"><Logo size={18} /></span>
          <div className="grow" />
          {!online && <span className="offline-pill" role="status">オフライン（閲覧・Draft保存のみ）</span>}
          {pending > 0 && <span className="sync-pill" title="未同期の変更">未同期 {pending}</span>}
          {workspace.is_sample ? <span className="sample-pill">サンプルWorkspace</span> : null}
          <button className="btn primary sm" onClick={() => nav('/sources/new')}>＋ 素材を追加</button>
        </header>
        <main className="content">{children}</main>
        <nav className="bottom-nav">
          {NAV.filter((n) => n.mobile).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'on' : '')}>
              <span aria-hidden>{n.icon}</span>
              <small>{n.label.replace(/ \(.*\)/, '')}</small>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const a = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => request('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', { email, password, name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    if (r) location.href = '/';
  };
  return (
    <div className="login">
      <div className="login-card">
        <Logo size={30} />
        <p className="tagline">1個作ったコンテンツを、1回で終わらせない。</p>
        <form onSubmit={submit} className="stack">
          {mode === 'register' && (
            <label>名前<input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>
          )}
          <label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
          <label>パスワード（10文字以上）<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
          <Err e={a.error} />
          <button className="btn primary" disabled={a.busy}>{mode === 'login' ? 'ログイン' : 'アカウント作成'}</button>
        </form>
        <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'アカウントを作成する' : 'ログインに戻る'}
        </button>
        <p className="small muted">開発環境のデモ: demo@sample-build-lab.invalid / demo-password-123</p>
      </div>
    </div>
  );
}

function Authed() {
  const [session, setS] = useState<Session | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = async () => {
    try {
      const me = await request('GET', '/api/auth/me');
      setSession(me.csrfToken);
      setS(me);
      const saved = savedWorkspace();
      const pick = me.workspaces.find((w: any) => w.id === saved)?.id ?? me.workspaces[0]?.id;
      setWorkspace(pick);
      setWsId(pick);
    } catch (e: any) {
      if (e?.status === 401) location.href = '/login';
      else setErr(e);
    }
  };
  useEffect(() => {
    load();
  }, []);
  if (err) return <div className="content"><Err e={err} /></div>;
  if (!session || !wsId) return <Loading />;
  const workspace = session.workspaces.find((w) => w.id === wsId)!;
  const switchWs = (id: string) => {
    setWorkspace(id);
    setWsId(id);
    location.href = '/';
  };
  return (
    <SessionCtx.Provider value={{ session, workspace, reloadSession: load, switchWs }}>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/sources/new" element={<NewSource />} />
          <Route path="/sources/:id" element={<SourceDetail />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/ideas/:id" element={<IdeaDetail />} />
          <Route path="/packs/:id" element={<PackDetail />} />
          <Route path="/content" element={<ContentList />} />
          <Route path="/content/:id" element={<ContentEditor />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/strategist" element={<StrategistPage />} />
          <Route path="/performance" element={<PerformancePage />} />
          <Route path="/recycling" element={<RecyclingPage />} />
          <Route path="/brand" element={<BrandPage />} />
          <Route path="/claims" element={<ClaimsPage />} />
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/share" element={<SharePage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Shell>
    </SessionCtx.Provider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<Authed />} />
      </Routes>
    </BrowserRouter>
  );
}

export { api };
