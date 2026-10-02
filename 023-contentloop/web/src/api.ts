let csrf = '';
let workspaceId = '';

export function setSession(token: string) {
  csrf = token;
}
export function setWorkspace(id: string) {
  workspaceId = id;
  try {
    localStorage.setItem('contentloop.ws', id);
  } catch {
    /* ignore */
  }
}
export function getWorkspace() {
  return workspaceId;
}
export function savedWorkspace() {
  try {
    return localStorage.getItem('contentloop.ws');
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export async function request<T = any>(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body instanceof Blob) {
    payload = body;
    headers['content-type'] = 'application/zip';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  if (opts.raw) return res as any;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `HTTP ${res.status}`, data?.details);
  if (res.headers.get('x-from-cache')) (data as any).__fromCache = true;
  return data as T;
}

/** Workspace-scoped API helper */
export const api = {
  get: <T = any>(p: string) => request<T>('GET', `/api/w/${workspaceId}${p}`),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', `/api/w/${workspaceId}${p}`, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', `/api/w/${workspaceId}${p}`, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', `/api/w/${workspaceId}${p}`),
  url: (p: string) => `/api/w/${workspaceId}${p}`,
  raw: (method: string, p: string, b?: unknown) => request<Response>(method, `/api/w/${workspaceId}${p}`, b, { raw: true }),
};
