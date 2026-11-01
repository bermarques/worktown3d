// Pocket phone (press P): quick access to boards, floors, the team, ready-to-merge PRs, activity, camera and settings.
import { h, avatarEl, ghLink, labelPill } from './dom.js';
import { confirmDialog } from './modal.js';
import { openBoardPanel, openDevPanel, openIssueForm } from './panels.js';
import { blip, shutter, hud } from './hud.js';
import { timeAgo } from '../engine/canvas.js';
import { BOARD_COLUMNS, prBadges } from '../world/screens.js';
import { can, roleLabel } from '../permissions.js';

const APPS = [
  { id: 'board', name: 'Board', icon: '📋', color: '#4dabf7' },
  { id: 'floors', name: 'Floors', icon: '🛗', color: '#fcc419' },
  { id: 'team', name: 'Team', icon: '👥', color: '#51cf66' },
  { id: 'me', name: 'Me', icon: '🪞', color: '#f783ac' },
  { id: 'ready', name: 'Ready', icon: '🚀', color: '#ff6b6b' },
  { id: 'activity', name: 'Activity', icon: '🔔', color: '#cc5de8' },
  { id: 'camera', name: 'Camera', icon: '📸', color: '#495057' },
  { id: 'settings', name: 'Settings', icon: '⚙️', color: '#868e96' },
];

const FLOOR_MAX_AGE = 60_000;

/**
 * @param {object} app    shared app state/actions from main.js
 * @param {{onOpen: Function, onClose: Function}} hooks  pointer-lock handling, same contract as modals
 */
export function createPhone(app, hooks) {
  const root = document.getElementById('phone-root');
  const screen = h('div', { class: 'phone-screen' });
  const clock = h('span', { class: 'phone-time' });
  const carrier = h('span', { class: 'phone-carrier' });
  root.replaceChildren(
    h('div', { class: 'hand-palm' }),
    h(
      'div',
      { class: 'phone' },
      h('div', { class: 'phone-notch' }),
      h(
        'div',
        { class: 'phone-glass' },
        h('div', { class: 'phone-status' }, clock, carrier, h('span', { class: 'phone-icons' }, '📶 🔋')),
        screen,
        h('button', { class: 'phone-homebar', title: 'Home', 'aria-label': 'Home', onClick: () => goHome() }, h('span')),
      ),
    ),
    h('div', { class: 'finger f1' }),
    h('div', { class: 'finger f2' }),
    h('div', { class: 'finger f3' }),
    h('div', { class: 'thumb' }),
  );

  const state = { open: false, view: 'home', params: {}, history: [] };
  const ui = { boardRepo: null, boardCol: 'inProgress', teamTab: null, teamQuery: '', photos: [] };
  const loading = new Set();
  const errors = new Map();
  let renderQueued = false;
  let clockTimer = null;

  // ---------------------------------------------------------------- navigation
  function go(view, params = {}) {
    state.history.push([state.view, state.params]);
    state.view = view;
    state.params = params;
    if (view === 'activity') app.markActivityRead();
    render();
    screen.scrollTop = 0;
  }
  function back() {
    const prev = state.history.pop() || ['home', {}];
    [state.view, state.params] = prev;
    render();
  }
  function goHome() {
    state.history = [];
    state.view = 'home';
    state.params = {};
    render();
  }

  function render() {
    if (!app.world) return;
    // keep focus/caret in the search box across re-renders
    const active = document.activeElement;
    const key = active && screen.contains(active) ? active.dataset.key : null;
    const caret = key && active.selectionStart;
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    carrier.textContent = app.world.owner.login;
    const view = VIEWS[state.view] || VIEWS.home;
    screen.replaceChildren(view(state.params));
    if (key) {
      const again = screen.querySelector(`[data-key="${key}"]`);
      if (again) {
        again.focus();
        if (caret != null && again.setSelectionRange) again.setSelectionRange(caret, caret);
      }
    }
  }

  function refresh() {
    if (!state.open || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (state.open && !(document.activeElement && document.activeElement.tagName === 'SELECT' && screen.contains(document.activeElement))) render();
    });
  }

  // ---------------------------------------------------------------- data helpers
  const floors = () => app.world.floors;
  const indexOf = (repo) => app.world.floors.indexOf(repo) + 1;
  const label = (i) => (i === 0 ? 'G' : `${i}F`);

  /** Someone who is in the building right now (multiplayer), or null. */
  const online = (login) => (app.live && app.live.connected ? app.live.playerByLogin(login) : null);
  /** Where an online person is: "here now", "in the lobby", "on 3F"; null when they're offline. */
  function liveLine(login) {
    const p = online(login);
    if (!p) return null;
    if (!p.at) return '🟢 just arrived';
    if (p.at.floor === app.currentRepo()) return '🟢 here now';
    return p.at.floor === null ? '🟢 in the lobby' : `🟢 on ${label(indexOf(p.at.floor))}`;
  }
  const withLive = (login, line) => {
    const live = liveLine(login);
    return live ? `${live} · ${line}` : line;
  };

  /** Cached floor data, refreshed in the background when older than maxAge. */
  function need(repo, maxAge = FLOOR_MAX_AGE) {
    const entry = app.cachedFloor(repo);
    if ((!entry || entry.age > maxAge) && !loading.has(repo)) {
      loading.add(repo);
      app
        .floorDataFor(repo)
        .then(() => errors.delete(repo))
        .catch((e) => errors.set(repo, e.message))
        .finally(() => {
          loading.delete(repo);
          refresh();
        });
    }
    return entry ? entry.data : null;
  }

  function needAll() {
    const out = floors().map((repo) => ({ repo, index: indexOf(repo), data: need(repo) }));
    const pending = floors().filter((r) => loading.has(r)).length;
    return { floors: out, pending };
  }

  function progress(pending, total) {
    if (!pending) return null;
    return h('div', { class: 'ph-progress' }, h('div', { class: 'spinner small' }), `Checking floors… ${total - pending}/${total}`);
  }

  function leaveFor(fn, { resume = true } = {}) {
    // close the phone, then do something that takes over the screen (ride, teleport, modal)
    api.close({ resume, silent: !resume });
    fn();
  }

  // ---------------------------------------------------------------- building blocks
  const appScreen = (title, ...content) =>
    h('div', { class: 'ph-app' }, h('div', { class: 'ph-head' }, h('button', { class: 'ph-back', onClick: back, 'aria-label': 'Back' }, '‹'), h('h3', null, title)), h('div', { class: 'ph-body' }, ...content));

  const empty = (text) => h('p', { class: 'ph-empty' }, text);

  function statusLine(dev, repo) {
    const ch = app.floorIndex && app.currentRepo() === repo && app.floor.characters ? app.floor.characters.find((c) => c.login === dev.login) : null;
    if (ch && ch.away) return '☕ on a coffee break';
    const c = dev.current;
    if (!c || dev.status !== 'working') return c && c.kind === 'merged' ? `💤 idle · shipped #${c.number}` : '💤 nothing assigned';
    if (c.kind === 'issue') return `🔨 #${c.number} ${c.title}`;
    return `${c.ready ? '🚀' : '👀'} PR #${c.number} ${c.title}`;
  }

  // ---------------------------------------------------------------- views
  const VIEWS = {
    home() {
      const here = app.floorIndex ? app.floorData : null;
      const readyCount = floors().reduce((n, r) => n + ((app.cachedFloor(r) || {}).data?.board.ready.length || 0), 0);
      const badges = { activity: app.unread, ready: readyCount };
      const widget = here
        ? h('div', { class: 'ph-widget' }, h('div', { class: 'ph-where' }, `📍 ${label(app.floorIndex)} · ${here.repo.name}`), h('div', { class: 'ph-stats' }, `👩‍💻 ${here.devs.length} here`, `🐞 ${here.issues.length} issues`, `🚀 ${here.board.ready.length} ready`))
        : h('div', { class: 'ph-widget' }, h('div', { class: 'ph-where' }, `📍 G · Lobby`), h('div', { class: 'ph-stats' }, `🛗 ${floors().length} floors`, `👥 ${app.world.memberCount ?? '—'} people`));
      return h(
        'div',
        { class: 'ph-home' },
        h('div', { class: 'ph-hello' }, `Hi @${app.viewerLogin()} 👋`),
        widget,
        h(
          'div',
          { class: 'ph-grid' },
          APPS.map((a) =>
            h(
              'button',
              // "Me" opens the passport right away (when there's an account to save the character to)
              { class: 'ph-icon', onClick: () => (a.id === 'me' && app.canCustomize() ? leaveFor(() => app.openCustomizer(), { resume: false }) : go(a.id)) },
              h('span', { class: 'ph-tile', style: { background: a.color } }, a.icon, badges[a.id] ? h('span', { class: 'ph-badge' }, badges[a.id] > 99 ? '99+' : String(badges[a.id])) : null),
              h('span', { class: 'ph-label' }, a.name),
            ),
          ),
        ),
        h('div', { class: 'ph-tip' }, 'Press P or Esc to put the phone away'),
      );
    },

    board() {
      if (!floors().length) return appScreen('Board', empty('No floors yet. Create a repo in the Manager’s Office.'));
      if (!ui.boardRepo || !floors().includes(ui.boardRepo)) ui.boardRepo = app.currentRepo() || floors()[0];
      const repo = ui.boardRepo;
      const data = need(repo, 30_000);
      const picker = h(
        'select',
        {
          class: 'ph-select',
          onChange: (e) => {
            ui.boardRepo = e.target.value;
            render();
          },
        },
        floors().map((r, i) => h('option', { value: r, selected: r === repo }, `${label(i + 1)} · ${r}`)),
      );
      if (!data) return appScreen('Board', picker, errors.has(repo) ? empty(`⚠️ ${errors.get(repo)}`) : progress(1, 1));
      const col = BOARD_COLUMNS.find((c) => c.key === ui.boardCol) || BOARD_COLUMNS[1];
      const items = data.board[col.key] || [];
      const isHere = app.currentRepo() === repo;
      return appScreen(
        'Board',
        picker,
        h(
          'div',
          { class: 'ph-cols' },
          BOARD_COLUMNS.map((c) =>
            h(
              'button',
              {
                class: `ph-col ${c.key === col.key ? 'on' : ''}`,
                style: { '--c': c.head },
                onClick: () => {
                  ui.boardCol = c.key;
                  render();
                },
              },
              h('b', null, String((data.board[c.key] || []).length)),
              h('small', null, c.title),
            ),
          ),
        ),
        items.length
          ? h(
              'div',
              { class: 'ph-list' },
              items.map((it) => {
                const people = it.assignees && it.assignees.length ? it.assignees : it.author ? [it.author] : [];
                const meta = col.key === 'review' || col.key === 'ready' ? prBadges(it).slice(0, 2).map(([t, bg, fg]) => h('span', { class: 'pill', style: { background: bg, color: fg } }, t)) : (it.labels || []).slice(0, 2).map(labelPill);
                return h(
                  'div',
                  { class: 'ph-card', style: { background: col.note } },
                  h('div', { class: 'ph-card-top' }, h('strong', null, `#${it.number}`), h('span', { class: 'avatars' }, people.slice(0, 3).map((p) => avatarEl(p, 20))), ghLink(it.url, '↗')),
                  h('div', { class: 'ph-card-title' }, it.title),
                  meta.length ? h('div', { class: 'item-meta' }, meta) : null,
                );
              }),
            )
          : empty(col.key === 'ready' ? 'Nothing ready to merge yet.' : `Nothing in ${col.title}.`),
        h(
          'div',
          { class: 'ph-actions' },
          isHere
            ? h('button', { class: 'btn small', onClick: () => leaveFor(() => openBoardPanel(app), { resume: false }) }, '🔍 Full board')
            : h('button', { class: 'btn small', onClick: () => leaveFor(() => app.rideTo(indexOf(repo))) }, `🛗 Go to ${label(indexOf(repo))}`),
          can.createIssue(app, repo) ? h('button', { class: 'btn small primary', onClick: () => leaveFor(() => openIssueForm(app, { repo }), { resume: false }) }, '+ New issue') : null,
        ),
      );
    },

    floors() {
      const rows = ['__lobby__', ...floors()].map((repo, i) => {
        const r = i ? app.world.repos.find((x) => x.name === repo) : null;
        const here = i === app.floorIndex;
        return h(
          'button',
          {
            class: `ph-floor ${here ? 'here' : ''}`,
            disabled: here,
            onClick: () => leaveFor(() => app.rideTo(i)),
          },
          h('span', { class: 'floor-num' }, label(i)),
          h('span', { class: 'ph-floor-text' }, h('strong', null, i ? repo : "Lobby & Manager's Office"), h('small', null, here ? 'You are here' : r ? `🐞 ${r.openIssues}  🔀 ${r.openPRs}${r.isPrivate ? '  🔒' : ''}` : '👔 Manage repos & issues')),
        );
      });
      return appScreen('Floors', h('div', { class: 'ph-list' }, rows));
    },

    team() {
      const onFloor = !!app.floorIndex;
      if (!ui.teamTab) ui.teamTab = onFloor ? 'floor' : 'everyone';
      if (ui.teamTab === 'floor' && !onFloor) ui.teamTab = 'everyone';
      const tabs = h(
        'div',
        { class: 'ph-tabs' },
        [
          ['floor', 'This floor'],
          ['everyone', 'Everyone'],
        ].map(([k, t]) =>
          h(
            'button',
            {
              class: `ph-tab ${ui.teamTab === k ? 'on' : ''}`,
              disabled: k === 'floor' && !onFloor,
              onClick: () => {
                ui.teamTab = k;
                render();
              },
            },
            t,
          ),
        ),
      );
      if (ui.teamTab === 'floor') {
        const data = app.floorData;
        const devs = new Set(data.devs.map((d) => d.login.toLowerCase()));
        // people visiting this floor live, who don't have a desk here
        const visitors = (app.live && app.live.connected ? app.live.online() : []).filter((p) => p.at && p.at.floor === data.repo.name && !devs.has(p.login.toLowerCase()));
        const rows = [
          ...visitors.map((p) => personRow(p.login, p.name, '🟢 here now · visiting', [label(app.floorIndex)])),
          ...data.devs.map((d) => personRow(d.login, d.name, withLive(d.login, statusLine(d, data.repo.name)), [label(app.floorIndex)])),
        ];
        return appScreen('Team', tabs, rows.length ? h('div', { class: 'ph-list' }, rows) : empty('Nobody works on this floor yet.'));
      }

      const { pending } = needAll();
      const where = whereIs();
      const q = ui.teamQuery.toLowerCase();
      const people = (app.world.members || [...where.keys()].map((login) => ({ login, name: null }))).filter((m) => !q || m.login.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
      // people in the building right now first, then whoever is busy
      const rank = (m) => (online(m.login) ? 0 : (where.get(m.login.toLowerCase()) || []).some((x) => x.dev.status === 'working') ? 1 : 2);
      people.sort((a, b) => rank(a) - rank(b) || a.login.localeCompare(b.login));
      const search = h('input', {
        class: 'ph-search',
        'data-key': 'team-search',
        placeholder: 'Search people…',
        value: ui.teamQuery,
        onInput: (e) => {
          ui.teamQuery = e.target.value;
          render();
        },
      });
      const rows = people.map((m) => {
        const spots = where.get(m.login.toLowerCase()) || [];
        const busy = spots.find((s) => s.dev.status === 'working');
        const line = busy ? `${statusLine(busy.dev, busy.repo)} · ${busy.repo}` : spots.length ? `💤 idle on ${spots.length} floor${spots.length > 1 ? 's' : ''}` : pending ? '…' : 'Not on any floor yet';
        return personRow(m.login, m.name, withLive(m.login, line), spots.map((s) => label(s.index)));
      });
      return appScreen('Team', tabs, search, progress(pending, floors().length), rows.length ? h('div', { class: 'ph-list' }, rows) : empty('Nobody matches that search.'));
    },

    person({ login }) {
      needAll();
      const spots = whereIs().get(login.toLowerCase()) || [];
      const member = (app.world.members || []).find((m) => m.login.toLowerCase() === login.toLowerCase());
      const live = online(login);
      const name = (member && member.name) || (spots[0] && spots[0].dev.name) || (live && live.name) || null;
      const sameFloor = live && live.at && live.at.floor === app.currentRepo();
      return appScreen(
        `@${login}`,
        h('div', { class: 'ph-person' }, avatarEl(login, 72), h('h3', null, name || `@${login}`), name ? h('div', { class: 'muted' }, `@${login}`) : null, app.isDemo ? null : ghLink(`https://github.com/${login}`, 'GitHub profile ↗')),
        live
          ? h(
              'div',
              { class: 'ph-card' },
              h('div', { class: 'ph-card-title' }, `${liveLine(login)}${live.at && live.at.floor ? ` · ${live.at.floor}` : ''}`),
              live.at ? h('div', { class: 'ph-actions' }, h('button', { class: 'btn small primary', onClick: () => leaveFor(() => app.goToPlayer(login)) }, sameFloor ? '📍 Show me' : '🏃 Take me there')) : null,
            )
          : null,
        spots.length
          ? spots.map((s) => {
              const c = s.dev.current;
              const here = app.currentRepo() === s.repo;
              return h(
                'div',
                { class: 'ph-card' },
                h('div', { class: 'ph-card-top' }, h('span', { class: 'floor-num tiny' }, label(s.index)), h('strong', null, s.repo), h('span', { class: 'muted small' }, `${s.dev.contributions} commits`)),
                h('div', { class: 'ph-card-title' }, statusLine(s.dev, s.repo)),
                c && c.body ? h('div', { class: 'muted small ph-clip' }, c.body.slice(0, 140)) : null,
                h(
                  'div',
                  { class: 'ph-actions' },
                  h('button', { class: 'btn small primary', onClick: () => leaveFor(() => app.goToPerson(login, s.repo)) }, here ? '📍 Show me' : '🏃 Take me there'),
                  here ? h('button', { class: 'btn small', onClick: () => leaveFor(() => openDevPanel(app, login), { resume: false }) }, 'Details') : null,
                ),
              );
            })
          : live
            ? null
            : empty(loading.size ? 'Looking around the building…' : `@${login} isn't on any floor yet. Assign them an issue to give them a desk!`),
      );
    },

    /** Only reached when the character can't be saved anywhere: the demo company. */
    me() {
      return appScreen(
        'Me',
        h('div', { class: 'ph-person' }, avatarEl(app.viewerLogin(), 72), h('h3', null, `@${app.viewerLogin()}`)),
        empty(app.status.hosted ? 'Sign in with GitHub to design your character: it’s saved with your account.' : 'Connect the GitHub CLI to design your character: it’s saved with your account.'),
      );
    },

    ready() {
      const { floors: all, pending } = needAll();
      const prs = [];
      for (const f of all) if (f.data) for (const p of f.data.board.ready) prs.push({ ...p, repo: f.repo, index: f.index });
      prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      const reviewing = all.reduce((n, f) => n + (f.data ? f.data.board.review.length : 0), 0);
      return appScreen(
        'Ready to merge',
        progress(pending, floors().length),
        h('div', { class: 'ph-summary' }, `🚀 ${prs.length} ready · 👀 ${reviewing} still in review`),
        prs.length
          ? h(
              'div',
              { class: 'ph-list' },
              prs.map((p) => {
                const merge = h('button', { class: 'btn small success' }, '🚀 Merge');
                merge.addEventListener('click', async () => {
                  const ok = await confirmDialog({
                    title: `Merge ${p.repo} #${p.number}?`,
                    message: `${p.title}\n\nSquash-merge into ${p.baseRefName || 'the base branch'}. ${app.isDemo ? 'Demo data only — nothing is sent to GitHub.' : 'This happens on GitHub.'}`,
                    confirmLabel: 'Merge it',
                  });
                  if (!ok) return;
                  merge.disabled = true;
                  merge.textContent = 'Merging…';
                  try {
                    await app.actions.merge(p.repo, p.number, 'squash');
                  } finally {
                    refresh();
                  }
                });
                return h(
                  'div',
                  { class: 'ph-card', style: { background: '#d3f9d8' } },
                  h('div', { class: 'ph-card-top' }, h('span', { class: 'floor-num tiny' }, label(p.index)), h('strong', null, `${p.repo} #${p.number}`), ghLink(p.url, '↗')),
                  h('div', { class: 'ph-card-title' }, p.title),
                  h('div', { class: 'muted small' }, `by @${p.author} · ${p.approvals} approval${p.approvals === 1 ? '' : 's'} · +${p.additions ?? 0} −${p.deletions ?? 0}`),
                  h('div', { class: 'ph-actions' }, can.merge(app, p.repo) ? merge : h('span', { class: 'muted small' }, 'Needs write access to merge'), h('button', { class: 'btn small', onClick: () => leaveFor(() => app.rideTo(p.index)) }, `🛗 ${label(p.index)}`)),
                );
              }),
            )
          : pending
            ? null
            : empty('Nothing is ready to merge right now. 🎉'),
      );
    },

    activity() {
      const items = app.activity;
      const clear = h(
        'button',
        {
          class: 'btn small ghost',
          onClick: () => {
            app.activity.length = 0;
            render();
          },
        },
        'Clear',
      );
      return appScreen(
        'Activity',
        items.length
          ? h(
              'div',
              { class: 'ph-list' },
              items.map((ev) => {
                const idx = ev.repo ? indexOf(ev.repo) : -1;
                return h(
                  'div',
                  { class: `ph-event ${ev.kind === 'you' ? 'you' : ''}` },
                  h('span', { class: 'ph-event-icon' }, ev.icon),
                  h('div', null, h('div', null, ev.text), h('small', { class: 'muted' }, `${ev.repo ? `${ev.repo} · ` : ''}${timeAgo(new Date(ev.at).toISOString())}`)),
                  idx > 0 && idx !== app.floorIndex ? h('button', { class: 'btn small ghost', title: `Ride to ${label(idx)}`, onClick: () => leaveFor(() => app.rideTo(idx)) }, label(idx)) : null,
                );
              }),
            )
          : empty('No news yet. New issues, pull requests and merges from floors you visit show up here.'),
        items.length ? h('div', { class: 'ph-actions' }, clear) : null,
      );
    },

    camera() {
      const snap = h('button', { class: 'ph-shutter', 'aria-label': 'Take photo' });
      snap.addEventListener('click', () => {
        const url = app.takePhoto();
        shutter();
        ui.photos.unshift({ url, at: new Date() });
        if (ui.photos.length > 12) ui.photos.pop();
        render();
      });
      return appScreen(
        'Camera',
        h('p', { class: 'muted small' }, 'Snaps exactly what you see — without the phone or HUD.'),
        h('div', { class: 'ph-camera' }, snap),
        ui.photos.length
          ? h(
              'div',
              { class: 'ph-photos' },
              ui.photos.map((p, i) => h('button', { class: 'ph-thumb', onClick: () => go('photo', { i }) }, h('img', { src: p.url, alt: `Photo ${i + 1}` }))),
            )
          : empty('No photos yet.'),
      );
    },

    photo({ i }) {
      const p = ui.photos[i];
      if (!p) return appScreen('Photo', empty('That photo is gone.'));
      const stamp = p.at.toISOString().replace(/[:T]/g, '-').slice(0, 19);
      return appScreen(
        'Photo',
        h('img', { class: 'ph-photo', src: p.url, alt: 'Snapshot of the office' }),
        h(
          'div',
          { class: 'ph-actions' },
          h('a', { class: 'btn small primary', href: p.url, download: `worktown3d-${stamp}.jpg` }, '💾 Save'),
          h(
            'button',
            {
              class: 'btn small ghost',
              onClick: () => {
                ui.photos.splice(i, 1);
                back();
              },
            },
            '🗑 Delete',
          ),
        ),
      );
    },

    settings() {
      const s = app.settings;
      const slider = (key, min, max, step, fmt) =>
        h(
          'label',
          { class: 'ph-setting' },
          h('span', null, fmt.label, h('b', null, fmt.value(s[key]))),
          h('input', {
            type: 'range',
            min,
            max,
            step,
            value: s[key],
            onInput: (e) => {
              app.applySettings({ [key]: Number(e.target.value) });
              e.target.previousSibling.lastChild.textContent = fmt.value(Number(e.target.value));
            },
          }),
        );
      const toggle = (key, text) =>
        h(
          'div',
          { class: 'ph-setting row space' },
          h('span', null, text),
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!s[key], onChange: (e) => app.applySettings({ [key]: e.target.checked }) }), h('span')),
        );
      return appScreen(
        'Settings',
        slider('sensitivity', 0.3, 2.5, 0.1, { label: 'Mouse sensitivity ', value: (v) => `${v.toFixed(1)}×` }),
        slider('fov', 55, 95, 1, { label: 'Field of view ', value: (v) => `${v}°` }),
        toggle('nameTags', '🏷️ Name tags'),
        toggle('shadows', '🌗 Shadows'),
        toggle('outlines', '✏️ Cartoon outlines'),
        toggle('sound', '🔊 Sounds'),
        h('div', { class: 'ph-about' }, h('strong', null, 'Worktown3D'), h('div', null, app.isDemo ? 'Demo company (fictional data)' : `Connected to @${app.world.owner.login} as @${app.viewerLogin()} (${roleLabel(app)})`)),
      );
    },
  };

  function personRow(login, name, line, floorLabels) {
    return h(
      'button',
      { class: 'ph-person-row', onClick: () => go('person', { login }) },
      avatarEl(login, 34),
      h('span', { class: 'ph-person-text' }, h('strong', null, name || `@${login}`), h('small', null, line)),
      floorLabels.length ? h('span', { class: 'ph-floor-chips' }, floorLabels.slice(0, 3).map((l) => h('span', { class: 'floor-num tiny' }, l))) : null,
    );
  }

  /** login (lowercase) -> [{repo, index, dev}] across every floor we have data for. */
  function whereIs() {
    const map = new Map();
    for (const repo of floors()) {
      const entry = app.cachedFloor(repo);
      if (!entry) continue;
      for (const dev of entry.data.devs) {
        const k = dev.login.toLowerCase();
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ repo, index: indexOf(repo), dev });
      }
    }
    return map;
  }

  // ---------------------------------------------------------------- open / close
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.confirm-layer')) return;
    e.preventDefault();
    api.close({ resume: false });
  };

  const api = {
    isOpen: () => state.open,
    open(view, params = {}) {
      if (state.open || !app.world) return;
      state.open = true;
      if (view) {
        state.history = [];
        state.view = view;
        state.params = params;
      }
      render();
      root.classList.add('open');
      document.addEventListener('keydown', onKey, true);
      clockTimer = setInterval(() => (clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), 15_000);
      blip(880);
      hooks.onOpen();
    },
    close({ resume = true, silent = false } = {}) {
      if (!state.open) return;
      state.open = false;
      root.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      clearInterval(clockTimer);
      if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
      blip(660);
      if (!silent) hooks.onClose({ resume });
    },
    toggle() {
      if (state.open) api.close({ resume: true });
      else api.open();
    },
    refresh,
    /** Called when activity arrives: updates the HUD badge and the home screen. */
    notify() {
      hud.setPhoneBadge(app.unread);
      if (state.open && (state.view === 'home' || state.view === 'activity')) {
        if (state.view === 'activity') app.markActivityRead();
        refresh();
      }
    },
  };
  return api;
}
