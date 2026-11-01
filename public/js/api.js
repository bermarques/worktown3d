// Fetch wrappers for the Worktown3D server.
let onSignedOut = () => {};

/** Called when the server says our session is gone (hosted mode) so the app can show the sign-in screen. */
export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Worktown3D': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.signedOut = !!(data && data.signedOut);
    err.noOrg = !!(data && data.noOrg);
    err.needsSubscription = !!(data && data.needsSubscription);
    if (err.signedOut) onSignedOut(err);
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  status: () => req('GET', '/api/status'),
  recheck: () => req('POST', '/api/recheck', {}),
  owners: () => req('GET', '/api/owners'),
  connect: (owner) => req('POST', '/api/connect', { owner }),
  useDemo: () => req('POST', '/api/connect', { demo: true }),
  startDemo: () => req('POST', '/api/demo', {}),
  logout: () => req('POST', '/auth/logout', {}),
  loginUrl: (next = location.pathname) => `/auth/login?next=${enc(next)}`,
  world: (fresh = false) => req('GET', `/api/world${fresh ? '?fresh=1' : ''}`),
  floor: (repo, fresh = false) => req('GET', `/api/floor/${enc(repo)}${fresh ? '?fresh=1' : ''}`),
  labels: (repo) => req('GET', `/api/labels/${enc(repo)}`),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  createRepo: (payload) => req('POST', '/api/repos', payload),
  createIssue: (repo, payload) => req('POST', `/api/issues/${enc(repo)}`, payload),
  updateIssue: (repo, number, patch) => req('PATCH', `/api/issues/${enc(repo)}/${number}`, patch),
  mergePR: (repo, number, method = 'squash') => req('POST', `/api/prs/${enc(repo)}/${number}/merge`, { method }),
  avatarUrl: (login) => `/api/avatar/${enc(login)}`,
  billing: () => req('GET', '/api/billing'),
  billingCheckout: () => req('POST', '/api/billing/checkout', {}),
  billingConfirm: (sessionId) => req('POST', '/api/billing/confirm', { sessionId }),
  billingPortal: () => req('POST', '/api/billing/portal', {}),
  connectWorkspace: (org) => req('POST', '/api/workspaces', { org }),
  disconnectWorkspace: (org) => req('DELETE', `/api/workspaces/${enc(org)}`, {}),
  myCharacter: () => req('GET', '/api/me/character'),
  saveCharacter: (character) => req('PUT', '/api/me/character', character),
  resetCharacter: () => req('DELETE', '/api/me/character', {}),
};
