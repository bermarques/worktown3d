// Title screen: GitHub connection status, organization picker and the "enter the building" button.
import { h } from './dom.js';
import { api } from '../api.js';
import { planCard, buildingButton } from './billing.js';

const CONTROLS = [
  ['W A S D', 'walk'],
  ['Shift', 'run'],
  ['Mouse', 'look around'],
  ['E / Click', 'interact'],
  ['P', 'phone'],
  ['Esc', 'pause / close'],
];

export function controlsList() {
  return h('div', { class: 'controls' }, CONTROLS.map(([k, v]) => h('div', null, h('kbd', null, k), h('span', null, v))));
}

/**
 * Render the start screen. Resolves the user's choice through callbacks:
 *  onEnter()            — status is ready, go in
 *  onReload()           — connection changed; reload the app
 */
export function renderStart(status, { onEnter, onReload, error, notice, needsSubscription }) {
  const root = document.getElementById('start');
  root.classList.add('show');
  const card = h('div', { class: 'start-card' });
  root.replaceChildren(card);

  if (status.hosted) {
    card.append(...hostedStart(status, { onEnter, onReload, error, notice, needsSubscription }), controlsList());
    return;
  }
  const title = titleBlock();

  const enterBtn = (label) => h('button', { class: 'btn big primary', onClick: onEnter }, label);

  const ownerPicker = async (container) => {
    container.replaceChildren(h('p', { class: 'muted' }, 'Loading your organizations…'));
    try {
      const owners = await api.owners();
      container.replaceChildren(
        h(
          'div',
          { class: 'owner-grid' },
          owners.map((o) =>
            h(
              'button',
              {
                class: `owner-btn ${o.login === status.owner && status.mode === 'github' ? 'here' : ''}`,
                onClick: async (e) => {
                  e.currentTarget.disabled = true;
                  try {
                    await api.connect(o.login);
                    onReload();
                  } catch (err) {
                    container.prepend(h('p', { class: 'error' }, err.message));
                  }
                },
              },
              h('strong', null, o.login),
              h('small', null, o.type === 'User' ? 'personal account' : o.description || 'organization'),
            ),
          ),
        ),
      );
    } catch (e) {
      container.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  };

  const demoBtn = h(
    'button',
    {
      class: 'btn ghost',
      onClick: async () => {
        await api.useDemo();
        onReload();
      },
    },
    'Explore the demo company instead',
  );

  const parts = [title];
  const gh = status.gh;
  if (status.mode === 'github' && status.owner) {
    const picker = h('div');
    parts.push(
      h('div', { class: 'status ok' }, `✅ GitHub CLI ${gh.version} · signed in as @${gh.user.login}`),
      h('p', null, 'Connected organization: ', h('strong', null, status.owner)),
      h('div', { class: 'row' }, enterBtn(`Enter ${status.owner} →`)),
      h('details', null, h('summary', { onClick: () => picker.childElementCount || ownerPicker(picker) }, 'Switch organization'), picker, demoBtn),
    );
  } else if (status.mode === 'github') {
    const picker = h('div');
    parts.push(h('div', { class: 'status ok' }, `✅ GitHub CLI ${gh.version} · signed in as @${gh.user.login}`), h('h3', null, 'Pick the organization to visualize'), picker, demoBtn);
    ownerPicker(picker);
  } else if (gh.authed && !status.forcedDemo) {
    const picker = h('div');
    parts.push(
      h('div', { class: 'status warn' }, '🎭 Demo company selected (fictional sample data)'),
      h('div', { class: 'row' }, enterBtn('Enter the demo company →')),
      h('details', null, h('summary', { onClick: () => picker.childElementCount || ownerPicker(picker) }, `Use a real organization (signed in as @${gh.user.login})`), picker),
    );
  } else {
    const again = h('button', { class: 'btn' }, '↻ Check again');
    again.addEventListener('click', async () => {
      again.disabled = true;
      again.textContent = 'Checking…';
      await api.recheck().catch(() => {});
      onReload();
    });
    parts.push(
      h('div', { class: 'status warn' }, status.forcedDemo ? '🎭 Demo mode (started with --demo)' : `🔌 ${gh.error || 'Not connected to GitHub'}`),
      status.forcedDemo
        ? null
        : h(
            'div',
            { class: 'setup' },
            h('p', null, 'To load your real organization, connect the GitHub CLI:'),
            h('ol', null, h('li', null, 'Install it: ', h('code', null, 'winget install --id GitHub.cli'), ' (or cli.github.com)'), h('li', null, 'Sign in: ', h('code', null, 'gh auth login')), h('li', null, 'Press “Check again” (no restart needed).')),
            again,
          ),
      h('div', { class: 'row' }, enterBtn('Enter the demo company →')),
    );
  }
  parts.push(controlsList());
  card.append(...parts.filter(Boolean));
}

function titleBlock() {
  return h('div', { class: 'start-title' }, h('div', { class: 'logo' }, '🏢'), h('div', null, h('h1', null, 'Worktown3D'), h('p', null, 'Walk around your GitHub organization. One floor per repo, every dev at their laptop.')));
}

/** /o/<org> in the address bar: a building link someone shared. */
export function orgFromPath() {
  const m = location.pathname.match(/^\/o\/([A-Za-z0-9-]{1,39})\/?$/);
  return m ? m[1] : null;
}

export const buildingLink = (org) => `${location.origin}/o/${encodeURIComponent(org)}`;

/** The building's shareable link with a copy button. Anyone can open it, but only org members get in. */
export function shareBox(org) {
  const link = buildingLink(org);
  const copy = h('button', { class: 'btn small' }, '📋 Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = '✅ Copied';
    } catch {
      copy.textContent = 'Select & copy';
    }
  });
  return h(
    'div',
    { class: 'share-box' },
    h('span', null, '🔗 Share with your team. They sign in with GitHub and see what their own access allows:'),
    h('div', { class: 'row' }, h('input', { value: link, readonly: true, 'aria-label': 'Building link', onFocus: (e) => e.target.select() }), copy),
  );
}

export async function signOut() {
  try {
    await api.logout();
  } finally {
    location.assign('/');
  }
}

const LOGIN_ERRORS = {
  denied: 'Sign-in was cancelled on GitHub.',
  expired: 'That sign-in link expired or was opened in another browser. Please try again.',
  github: "GitHub didn't accept the sign-in. Please try again.",
};

/** Hosted mode: sign in with GitHub, pick (or follow a link to) an organization, share the building. */
function hostedStart(status, { onEnter, onReload, error, notice, needsSubscription }) {
  const parts = [titleBlock()];
  const linkOrg = orgFromPath();
  const loginError = LOGIN_ERRORS[new URLSearchParams(location.search).get('login_error')];
  const signInBtn = (label = 'Sign in with GitHub') => h('a', { class: 'btn big primary', href: api.loginUrl(linkOrg ? `/o/${linkOrg}` : '/') }, label);
  const demoBtn = h('button', { class: 'btn ghost' }, '🎭 Try the demo company');
  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    try {
      await api.startDemo();
      onReload();
    } catch (e) {
      demoBtn.disabled = false;
      demoBtn.after(h('p', { class: 'error' }, e.message));
    }
  });

  // not signed in
  if (!status.mode) {
    if (linkOrg) parts.push(h('div', { class: 'status ok' }, '📨 You were invited to the ', h('strong', null, linkOrg), ' building. Sign in with the GitHub account you use there.'));
    if (loginError) parts.push(h('p', { class: 'error' }, loginError));
    parts.push(
      h('div', { class: 'row' }, signInBtn(), demoBtn),
      h('p', { class: 'muted small' }, 'You only see what your GitHub account can already see, and can only do what it is allowed to do. Your GitHub token never reaches the browser and is revoked when you sign out.'),
    );
    return parts;
  }

  if (status.mode === 'demo') {
    parts.push(
      h('div', { class: 'status warn' }, '🎭 Demo company: fictional data, just for you. Changes vanish when you leave.'),
      h('div', { class: 'row' }, h('button', { class: 'btn big primary', onClick: onEnter }, 'Enter the demo company →'), signInBtn('Sign in with GitHub instead')),
    );
    return parts;
  }

  parts.push(h('div', { class: 'status ok row space' }, h('span', null, '✅ Signed in as ', h('strong', null, `@${status.user.login}`)), h('button', { class: 'btn small ghost', onClick: signOut }, 'Sign out')));
  if (notice) parts.push(h('div', { class: `status ${notice.kind === 'ok' ? 'ok' : 'warn'}` }, notice.text));
  if (error) parts.push(h('p', { class: 'error' }, error));
  // subscriptions: subscribers always see their plan; everyone else gets a one-line teaser unless they need it now
  if (status.billing) parts.push(planCard({ compact: !!status.owner && !error && !needsSubscription }));

  const picker = h('div');
  const loadPicker = async () => {
    picker.replaceChildren(h('p', { class: 'muted' }, 'Loading your organizations…'));
    try {
      const [owners, summary] = await Promise.all([api.owners(), status.billing ? api.billing().catch(() => null) : null]);
      picker.replaceChildren(...[
        owners.length
          ? h(
              'div',
              { class: 'owner-grid' },
              // open buildings are real links, so the address bar always holds a shareable building URL
              owners.map((o) => buildingButton(o, { current: status.owner, summary })),
            )
          : h('p', { class: 'muted' }, 'No organizations available yet.'),
        status.installUrl ? h('p', { class: 'muted small' }, "Don't see your organization? An owner needs to ", h('a', { href: status.installUrl, target: '_blank', rel: 'noopener noreferrer' }, 'install the Worktown3D GitHub App'), ' on it.') : null,
      ].filter(Boolean));
    } catch (e) {
      picker.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  };

  if (status.owner && !needsSubscription) {
    parts.push(
      h('div', { class: 'row' }, h('button', { class: 'btn big primary', onClick: onEnter }, `Enter ${status.owner} →`)),
      shareBox(status.owner),
      h('details', null, h('summary', { onClick: () => picker.childElementCount || loadPicker() }, 'Switch organization'), picker),
    );
  } else {
    parts.push(h('h3', null, 'Pick a building to enter'), picker);
    loadPicker();
  }
  return parts;
}

export function hideStart() {
  document.getElementById('start').classList.remove('show');
}
