// Worktown3D client entry: renderer, game loop, floor management, elevator rides, live polling and actions.
import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { api, setSignedOutHandler } from './api.js';
import { Player, Interactor } from './engine/player.js';
import { setAvatarsEnabled, onAvatarsLoaded } from './engine/canvas.js';
import { RepoFloor } from './world/repoFloor.js';
import { LobbyFloor } from './world/lobbyFloor.js';
import { RemotePlayers } from './world/remotePlayers.js';
import { Live } from './live.js';
import { WALL_T } from './world/building.js';
import { hud, ding, setSoundEnabled } from './ui/hud.js';
import { setModalHooks, isModalOpen } from './ui/modal.js';
import { setRealAvatars, h } from './ui/dom.js';
import { openDevPanel, openBoardPanel, openElevatorPanel, openRepoInfo, openRobot } from './ui/panels.js';
import { openManagerConsole } from './ui/manager.js';
import { renderStart, hideStart, controlsList, orgFromPath, signOut } from './ui/start.js';
import { createPhone } from './ui/phone.js';
import { billingReturnNotice } from './ui/billing.js';
import { openCustomizer } from './ui/customizer.js';

// ------------------------------------------------------------------ renderer & scene
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const effect = new OutlineEffect(renderer, { defaultThickness: 0.0032, defaultColor: [0.1, 0.09, 0.15], defaultAlpha: 1 });

const scene = new THREE.Scene();
scene.background = new THREE.Color('#bfe6ff');
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight('#ffffff', '#d8c3a5', 1.5));
scene.add(new THREE.AmbientLight('#ffffff', 0.35));
const sun = new THREE.DirectionalLight('#fff3dd', 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

function fitShadow({ W, D }) {
  sun.position.set(W * 0.15, 22, D * 0.2);
  sun.target.position.set(0, 0, 0);
  const s = Math.max(W, D) * 0.62;
  const cam = sun.shadow.camera;
  cam.left = -s;
  cam.right = s;
  cam.top = s;
  cam.bottom = -s;
  cam.near = 1;
  cam.far = 60;
  cam.updateProjectionMatrix();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const player = new Player(camera, canvas);
const interactor = new Interactor(camera);

// Multiplayer: the other people in the building right now, drawn on the floor you're on.
const remote = new RemotePlayers({ onChange: () => refreshTargets() });
scene.add(remote.group);

/** What the crosshair can interact with: the floor's things and the people walking around it. */
function refreshTargets() {
  if (app.floor) interactor.setTargets([...app.floor.interactables, ...remote.hitboxes(), ...app.floor.occluders]);
}

// ------------------------------------------------------------------ settings (phone ⚙️, remembered per browser)
const SETTINGS_KEY = 'worktown3d.settings';
const DEFAULT_SETTINGS = { sensitivity: 1, fov: 70, nameTags: true, shadows: true, outlines: true, sound: true };
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
const settings = loadSettings();

function applySettings() {
  player.setSensitivity(settings.sensitivity);
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  sun.castShadow = settings.shadows;
  setSoundEnabled(settings.sound);
  if (app.floor) app.floor.showTags = settings.nameTags;
}

function renderFrame() {
  if (settings.outlines) effect.render(scene, camera);
  else renderer.render(scene, camera);
}

// ------------------------------------------------------------------ app state
let entered = false;
let riding = false;
let attract = true; // slow camera pan behind the title screen

const app = {
  status: null,
  world: null,
  floor: null,
  floorIndex: 0,
  floorData: null,
  isDemo: false,
  /** Multiplayer connection (organization buildings in hosted mode), or null. */
  live: null,
  /** Your saved character: undefined until loaded, null for the look drawn from your login. */
  myCharacter: undefined,
  floorCache: new Map(),
  liveModals: new Set(),

  floorLabels() {
    return ['G', ...this.world.floors.map((_, i) => `${i + 1}F`)];
  },
  currentRepo() {
    return this.floorIndex ? this.world.floors[this.floorIndex - 1] : null;
  },
  onFloorData(modal) {
    this.liveModals.add(modal);
  },
  async teamFor(repo) {
    let data = this.floorCache.get(repo);
    if (!data) {
      data = await api.floor(repo);
      this.floorCache.set(repo, data);
    }
    if (data.devs.length) return data.devs;
    return (this.world.members || []).map((m) => ({ login: m.login, name: m.name }));
  },
  rideTo,
  refreshFloor,
  refreshWorld,
  actions: {},

  // ---- used by the phone
  settings,
  activity: [],
  unread: 0,
  /** The signed-in person (hosted), the gh CLI account (local), or the demo persona. */
  viewerLogin() {
    const s = this.status;
    if (!s) return 'manager';
    if (s.hosted) return (s.user && s.user.login) || (s.viewer && s.viewer.login) || 'visitor';
    return (s.gh && s.gh.user && !this.isDemo ? s.gh.user.login : s.viewer && s.viewer.login) || 'manager';
  },
  applySettings(patch) {
    Object.assign(settings, patch);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* private mode: settings just won't stick */
    }
    applySettings();
  },
  /** { data, age } for a floor we've loaded before, or null. */
  cachedFloor(repo) {
    const data = this.floorCache.get(repo);
    return data ? { data, age: Date.now() - (floorLoadedAt.get(repo) || 0) } : null;
  },
  floorDataFor(repo) {
    return queued(() => loadFloorData(repo));
  },
  log(event) {
    this.activity.unshift({ at: Date.now(), kind: 'news', ...event });
    if (this.activity.length > 100) this.activity.length = 100;
    if (event.kind !== 'you') this.unread++;
    phone.notify();
  },
  markActivityRead() {
    this.unread = 0;
    hud.setPhoneBadge(0);
  },
  goToPerson,
  goToPlayer,
  /** Is there an account to save a character to? (Signed in with GitHub, or the GitHub CLI's account locally.) */
  canCustomize() {
    const s = this.status;
    return !!s && !this.isDemo && (s.hosted ? !!s.user : s.mode === 'github');
  },
  /** The passport (phone → Me), starting from your saved character. */
  async openCustomizer() {
    if (this.myCharacter === undefined) {
      try {
        this.myCharacter = (await api.myCharacter()).character;
      } catch (e) {
        hud.toast(`⚠️ ${e.message}`, 'error', 7000);
        return;
      }
    }
    openCustomizer(app, {
      onSaved: (character) => {
        app.myCharacter = character;
        characterChanged(app.viewerLogin(), character);
      },
    });
  },
  takePhoto() {
    renderFrame();
    return canvas.toDataURL('image/jpeg', 0.92);
  },
};
window.worktown3d = { app, player, camera }; // handy for debugging in the console

// Phone lookups can hit every floor at once; keep the local server (and gh) to a few requests at a time.
const floorLoadedAt = new Map();
let inFlight = 0;
const waiting = [];
function queued(job) {
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlight++;
      job()
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          if (waiting.length) waiting.shift()();
        });
    };
    if (inFlight < 3) run();
    else waiting.push(run);
  });
}

// ------------------------------------------------------------------ floors
function mountFloor(index, data, { arriveInElevator = false, keepPosition = false } = {}) {
  const prev = app.floor;
  const rel = prev && keepPosition ? { x: camera.position.x - prev.elevator.x0, z: camera.position.z } : null;
  if (prev) {
    scene.remove(prev.group);
    prev.dispose();
  }
  const floorLabels = app.floorLabels();
  const floor = index === 0 ? new LobbyFloor({ world: app.world, floorLabels }) : new RepoFloor({ data, world: app.world, floorNumber: index, floorLabels });
  scene.add(floor.group);
  app.floor = floor;
  app.floorIndex = index;
  app.floorData = index ? data : null;
  player.colliders = floor.colliders;
  remote.setFloor(floor, index ? data.repo.name : null); // also refreshes the interaction targets
  fitShadow(floor.bounds);
  floor.showTags = settings.nameTags;

  if (rel) player.setPosition(floor.elevator.x0 + rel.x, rel.z);
  else if (arriveInElevator) player.setPosition(floor.elevator.x0 - WALL_T - 1.0, 0, -Math.PI / 2);
  else player.setPosition(floor.spawn.x, floor.spawn.z, floor.spawn.yaw);

  const owner = app.world.owner.login;
  hud.setFloor(floor.floorLabel, index ? `${owner}/${data.repo.name}` : `${owner} · Lobby & Manager's Office`);
  document.title = index ? `${floor.floorLabel} ${data.repo.name} · Worktown3D` : `${owner} · Worktown3D`;
}

async function loadFloorData(repo, fresh = false, { quiet = false } = {}) {
  const prev = app.floorCache.get(repo);
  const data = await api.floor(repo, fresh);
  app.floorCache.set(repo, data);
  floorLoadedAt.set(repo, Date.now());
  // Anything that changed since we last looked goes into the phone's activity feed.
  if (prev && !quiet) for (const ev of diffFloor(prev, data)) app.log({ ...ev, repo });
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, maxMs) {
  const start = performance.now();
  while (!fn() && performance.now() - start < maxMs) await sleep(30);
}

async function rideTo(index) {
  if (riding || !app.floor || index === app.floorIndex || index < 0 || index > app.world.floors.length) return;
  riding = true;
  const elev = app.floor.elevator;
  const inside = elev.isInside(camera.position.x, camera.position.z);
  const label = index === 0 ? 'G' : `${index}F`;
  player.frozen = true;
  elev.locked = true;
  elev.setIndicator(app.floor.floorLabel, index > app.floorIndex ? '▲' : '▼');
  await waitFor(() => elev.closed, 1500);
  await hud.fade(1, 380);
  hud.loading(index ? `Riding up to ${label} · ${app.world.floors[index - 1]}…` : 'Heading down to the lobby…');
  let data = null;
  try {
    if (index) data = await loadFloorData(app.world.floors[index - 1]);
  } catch (e) {
    hud.loading(null);
    hud.toast(`Couldn't load that floor: ${e.message}`, 'error', 7000);
    elev.locked = false;
    elev.setIndicator(app.floor.floorLabel);
    await hud.fade(0, 300);
    player.frozen = false;
    riding = false;
    return;
  }
  for (const m of app.liveModals) m.close?.({ resume: false, silent: true });
  app.liveModals.clear();
  mountFloor(index, data, { keepPosition: inside, arriveInElevator: !inside });
  app.floor.elevator.locked = true;
  hud.loading(null);
  await hud.fade(0, 380);
  ding();
  await sleep(350);
  app.floor.elevator.locked = false;
  player.frozen = false;
  riding = false;
}

/** Ride to someone's floor (if needed), stand next to them and drop a marker over their head. */
async function goToPerson(login, repo) {
  if (app.live && app.live.connected && app.live.playerByLogin(login)) return goToPlayer(login); // they're walking around
  const index = app.world.floors.indexOf(repo) + 1;
  if (!index) return;
  if (app.floorIndex !== index) {
    await rideTo(index);
    if (app.floorIndex !== index) return;
  }
  const spot = app.floor.personSpot(login);
  if (!spot) {
    hud.toast(`🏠 @${login} is working remotely today — no desk on this floor`, 'info');
    return;
  }
  await hud.fade(1, 180);
  player.setPosition(spot.x, spot.z, spot.yaw);
  camera.rotation.x = -0.12;
  await hud.fade(0, 260);
  app.floor.highlight(login);
}

/**
 * Someone's look changed (you saved yours, or a teammate saved theirs): the floors we've loaded get it, and their
 * desk character on this floor is redrawn. Others see your change through the API (live, or with their next refresh).
 */
function characterChanged(login, character) {
  const key = login.toLowerCase();
  for (const data of app.floorCache.values()) for (const dev of data.devs) if (dev.login.toLowerCase() === key) dev.character = character;
  if (app.floor && app.floor.restyle && app.floor.restyle(login, character)) refreshTargets();
}

/** Ride to where someone who is in the building right now stands, and face them. */
async function goToPlayer(login) {
  const at = () => {
    const p = app.live && app.live.playerByLogin(login);
    return p && p.at;
  };
  if (!at()) return hud.toast(`@${login} isn't around right now`, 'info');
  const index = at().floor === null ? 0 : app.world.floors.indexOf(at().floor) + 1;
  if (at().floor !== null && !index) return hud.toast(`@${login} is on ${at().floor}, which has no floor here`, 'info');
  if (app.floorIndex !== index) {
    await rideTo(index);
    if (app.floorIndex !== index) return;
  }
  const spot = at();
  if (!spot) return hud.toast(`@${login} just left`, 'info');
  await hud.fade(1, 180);
  // a step in front of them, looking at them
  player.setPosition(spot.x - Math.sin(spot.yaw) * 1.4, spot.z - Math.cos(spot.yaw) * 1.4, spot.yaw + Math.PI);
  await hud.fade(0, 260);
}

// ------------------------------------------------------------------ live updates
/** What changed on a floor between two snapshots, as activity events. */
function diffFloor(prev, next) {
  const events = [];
  const had = (list, n) => list.some((x) => x.number === n);
  for (const i of next.issues) if (!had(prev.issues, i.number) && !had(prev.merged, i.number)) events.push({ icon: '🆕', text: `New issue #${i.number}: ${i.title}`, tone: 'info' });
  for (const p of next.prs) if (!had(prev.prs, p.number)) events.push({ icon: '🔀', text: `@${p.author} opened PR #${p.number}: ${p.title}`, tone: 'info' });
  for (const p of next.board.ready) if (!had(prev.board.ready, p.number)) events.push({ icon: '🚀', text: `PR #${p.number} is ready to merge`, tone: 'success' });
  for (const m of next.merged) if (!had(prev.merged, m.number)) events.push({ icon: '✅', text: `PR #${m.number} merged: ${m.title}`, tone: 'success' });
  return events;
}

function announceChanges(prev, next) {
  if (!prev || prev.repo.name !== next.repo.name) return;
  diffFloor(prev, next)
    .slice(0, 3)
    .forEach((ev) => hud.toast(`${ev.icon} ${ev.text}`, ev.tone, 6000));
}

function rerenderLiveModals() {
  for (const m of [...app.liveModals]) {
    if (!m.el.isConnected) {
      app.liveModals.delete(m);
      continue;
    }
    // don't yank the UI from under someone who is mid-selection
    if (m.el.contains(document.activeElement) && document.activeElement !== document.body && document.activeElement.tagName === 'SELECT') continue;
    m.render();
  }
  phone.refresh();
}

async function refreshFloor(fresh = false, { quiet = false } = {}) {
  if (!app.floorIndex) return;
  const repo = app.currentRepo();
  const index = app.floorIndex;
  const data = await loadFloorData(repo, fresh, { quiet });
  if (app.currentRepo() !== repo || riding) return;
  if (!quiet) announceChanges(app.floorData, data);
  if (!app.floor.updateData(data)) {
    hud.toast('👋 The team on this floor changed — rearranging desks', 'info');
    mountFloor(index, data, { keepPosition: true });
  } else refreshTargets(); // someone's desk character may have been redrawn with a new look
  app.floorData = data;
  rerenderLiveModals();
}

async function refreshWorld(fresh = false) {
  const world = await api.world(fresh);
  const floorsChanged = world.floors.join('|') !== app.world.floors.join('|');
  const currentRepo = app.currentRepo();
  app.world = world;
  if (floorsChanged && app.floor && !riding) {
    // keep standing on the same repo even if its floor number moved
    const idx = currentRepo ? world.floors.indexOf(currentRepo) + 1 : 0;
    if (currentRepo && idx === 0) {
      hud.toast(`${currentRepo} no longer has a floor — taking you to the lobby`, 'warn');
      mountFloor(0, null);
    } else mountFloor(idx, app.floorData, { keepPosition: true });
  } else if (app.floor) app.floor.setWorld(world);
  rerenderLiveModals();
}

let pollTimers = [];
function startPolling() {
  pollTimers.forEach(clearInterval);
  pollTimers = [
    setInterval(() => {
      if (!document.hidden && entered && !riding) refreshFloor(false).catch((e) => console.warn('floor refresh failed', e));
    }, 30_000),
    setInterval(() => {
      if (!document.hidden && entered && !riding) refreshWorld(false).catch((e) => console.warn('world refresh failed', e));
    }, 120_000),
  ];
}

onAvatarsLoaded(() => {
  if (app.floor) app.floor.refreshAvatars();
  remote.refreshAvatars();
});

// ------------------------------------------------------------------ actions (manager powers)
async function guard(promise) {
  try {
    return await promise;
  } catch (e) {
    hud.toast(`⚠️ ${e.message}`, 'error', 8000);
    throw e;
  }
}

async function afterRepoChange(repo) {
  app.floorCache.delete(repo);
  const jobs = [refreshWorld(true)];
  if (app.currentRepo() === repo) jobs.push(refreshFloor(true, { quiet: true }));
  await Promise.allSettled(jobs);
}

app.actions = {
  async createIssue(repo, payload) {
    const r = await guard(api.createIssue(repo, payload));
    hud.toast(`📝 Issue #${r.number} created in ${repo}${payload.assignees.length ? ` for @${payload.assignees.join(', @')}` : ''}`, 'success');
    app.log({ kind: 'you', icon: '📝', text: `You opened #${r.number}: ${payload.title}`, repo });
    await afterRepoChange(repo);
    return r;
  },
  async assign(repo, number, assignees) {
    await guard(api.updateIssue(repo, number, { assignees }));
    hud.toast(assignees.length ? `👉 #${number} assigned to @${assignees.join(', @')}` : `#${number} is back in the backlog`, 'success');
    app.log({ kind: 'you', icon: '👉', text: assignees.length ? `You assigned #${number} to @${assignees.join(', @')}` : `You unassigned #${number}`, repo });
    await afterRepoChange(repo);
  },
  async closeIssue(repo, number) {
    await guard(api.updateIssue(repo, number, { state: 'closed' }));
    hud.toast(`🗂️ Closed #${number}`, 'success');
    app.log({ kind: 'you', icon: '🗂️', text: `You closed #${number}`, repo });
    await afterRepoChange(repo);
  },
  async merge(repo, number, method) {
    const r = await guard(api.mergePR(repo, number, method));
    hud.toast(r.merged === false ? `PR #${number}: ${r.message}` : `🚀 Merged PR #${number}`, r.merged === false ? 'warn' : 'success');
    if (r.merged !== false) app.log({ kind: 'you', icon: '🚀', text: `You merged PR #${number}`, repo });
    await afterRepoChange(repo);
  },
  async createRepo(payload) {
    const r = await guard(api.createRepo(payload));
    hud.toast(`✨ Created ${r.name} — it has a floor now`, 'success');
    app.log({ kind: 'you', icon: '✨', text: `You created the repo ${r.name}`, repo: r.name });
    await refreshWorld(true);
    return r;
  },
  async saveFloors(floors) {
    const s = await guard(api.saveSettings({ floors }));
    app.world.floors = s.floors;
    await refreshWorld(false);
  },
  async saveLinks(links) {
    const s = await guard(api.saveSettings({ links }));
    app.world.links = s.links;
    if (app.floor) app.floor.setWorld(app.world);
    hud.toast('🔗 Connections saved', 'success');
  },
  async switchOwner(owner) {
    if (owner) await guard(api.connect(owner));
    location.reload();
  },
  async switchToDemo() {
    await guard(api.useDemo());
    location.reload();
  },
  async recheck() {
    app.status = await guard(api.recheck());
    if (app.status.mode === 'github') location.reload();
    else hud.toast(app.status.gh.error || 'Still not connected', 'warn', 7000);
  },
};

// ------------------------------------------------------------------ interaction & pointer lock
function interact(info) {
  switch (info.kind) {
    case 'dev':
      return openDevPanel(app, info.login);
    case 'board':
      return openBoardPanel(app);
    case 'elevator':
      return openElevatorPanel(app);
    case 'repoInfo':
      return openRepoInfo(app);
    case 'manager':
      return openManagerConsole(app, 'floors');
    case 'managerLinks':
      return openManagerConsole(app, 'links');
    case 'robot':
      return openRobot(app);
    case 'player':
      return phone.open('person', { login: info.login });
  }
}

let currentHint = null;
function tryInteract() {
  if (!entered || riding || uiBlocked() || !player.active || !currentHint) return;
  interact(currentHint);
}

// Panels and the phone both free the mouse; closing them with a click/key re-captures it.
const overlayHooks = {
  onOpen: () => {
    player.unlock();
    hud.pause(false);
  },
  onClose: ({ resume }) => {
    if (!entered) return;
    if (player.dragMode) return;
    if (resume) player.lock();
    else hud.pause(true);
  },
};
setModalHooks(overlayHooks);
const phone = createPhone(app, overlayHooks);
app.phone = phone;

function uiBlocked() {
  return isModalOpen() || phone.isOpen();
}

const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyE') tryInteract();
  if (e.code === 'KeyP' && entered && !riding && !isModalOpen() && !typing(e)) phone.toggle();
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (player.locked) tryInteract();
});
document.getElementById('phone-chip').addEventListener('click', () => {
  if (entered && !riding && !isModalOpen()) phone.toggle();
});
document.getElementById('online-chip').addEventListener('click', () => {
  if (entered && !riding && !isModalOpen()) phone.open('team');
});

let everLocked = false;
player.controls.addEventListener('lock', () => {
  everLocked = true;
  hud.pause(false);
});
player.controls.addEventListener('unlock', () => {
  if (entered && !uiBlocked() && !player.dragMode) hud.pause(true);
});
document.addEventListener('pointerlockerror', () => {
  if (!everLocked && !player.dragMode) {
    // Embedded browsers often block pointer lock: fall back to drag-to-look.
    player.enableDragMode(tryInteract);
    hud.pause(false);
    hud.toast('🖱️ Mouse capture is unavailable here — hold and drag to look around, click to interact.', 'info', 8000);
    return;
  }
  if (entered && !uiBlocked() && !player.dragMode) hud.pause(true);
});

const pauseEl = document.getElementById('pause');
pauseEl.querySelector('.pause-controls').replaceWith(controlsList());
pauseEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-action=start]')) {
    location.reload();
    return;
  }
  if (e.target.closest('[data-action=signout]')) {
    signOut();
    return;
  }
  player.lock();
});

// Hosted mode: if the session ends (signed out elsewhere, token revoked, removed from the org) go back to sign-in.
let leaving = false;
function sessionEnded() {
  if (leaving || !entered) return;
  leaving = true;
  hud.toast('🔒 Your sign-in ended. Taking you back to the sign-in screen…', 'warn', 4000);
  setTimeout(() => location.reload(), 1800);
}
setSignedOutHandler(sessionEnded);

// ------------------------------------------------------------------ multiplayer
/** In an organization's building (hosted mode), see the other people who are here right now, and be seen. */
function startLive() {
  const s = app.status;
  // Personal buildings and the demo stay single-player.
  if (!s.hosted || s.mode !== 'github' || app.world.owner.type !== 'Organization') return;
  app.live = new Live({
    onEvent(event, someone) {
      switch (event) {
        case 'welcome':
          remote.reset(app.live.online(), app.viewerLogin());
          break;
        case 'offline':
          remote.reset([]);
          break;
        case 'join':
          hud.toast(`👋 @${someone.login} is here`, 'info', 3500);
          remote.upsert(someone);
          break;
        case 'rejoin':
        case 'move':
        case 'floor':
          remote.upsert(someone);
          break;
        case 'leave':
          remote.remove(someone);
          break;
        case 'character':
          remote.restyle(someone);
          characterChanged(someone.login, someone.character);
          break;
      }
      if (event === 'move') return; // the HUD and the phone don't show exact positions
      hud.setOnline(app.live.online().length);
      phone.refresh();
    },
    onSignedOut: sessionEnded,
    onUnavailable(code, reason) {
      const why = {
        4001: '👥 This building is open in another tab or window: people see you there, not here.',
        4403: `🔒 Others can't see you here: ${reason}`,
        4409: '🏢 You opened another building in another tab. Reload to see who is here.',
        4429: "🏢 The building is full right now: others will see you when there's room.",
      }[code];
      if (why) hud.toast(why, 'warn', 9000);
    },
  });
  app.live.start();
}

// ------------------------------------------------------------------ boot
async function boot() {
  hud.showHud(false);
  let status;
  try {
    status = await api.status();
  } catch (e) {
    document.getElementById('start').classList.add('show');
    document.getElementById('start').replaceChildren(h('div', { class: 'start-card' }, h('h1', null, 'Worktown3D'), h('p', { class: 'error' }, `Can't reach the server: ${e.message}`), h('p', null, 'Make sure it is running and reload.')));
    return;
  }

  const notice = status.hosted && status.user ? await billingReturnNotice() : null;

  // A building link (/o/<org>) opens that organization, as long as GitHub says you belong to it.
  let connectError = null;
  const linkOrg = orgFromPath();
  if (linkOrg && status.mode === 'github' && linkOrg.toLowerCase() !== String(status.owner || '').toLowerCase()) {
    try {
      status = await api.connect(linkOrg);
    } catch (e) {
      connectError = e.message;
      status = await api.status().catch(() => status);
    }
  }
  if (status.hosted && status.mode === 'github' && status.owner && !linkOrg) history.replaceState(null, '', `/o/${encodeURIComponent(status.owner)}`);
  if (status.hosted && status.mode === 'demo' && linkOrg) history.replaceState(null, '', '/');
  if (status.hosted && status.user) {
    pauseEl.querySelector('.pause-card').append(h('button', { class: 'btn ghost', 'data-action': 'signout' }, `Sign out @${status.user.login}`));
  }

  app.status = status;
  app.isDemo = status.mode === 'demo';
  setAvatarsEnabled(!app.isDemo);
  setRealAvatars(!app.isDemo);

  let worldPromise = null;
  if (status.mode && status.owner) {
    worldPromise = api.world().then((w) => {
      app.world = w;
      if (!entered) mountFloor(0, null); // backdrop for the title screen
      return w;
    });
    worldPromise.catch(() => {});
  }

  const startOptions = {
    error: connectError,
    notice,
    onReload: () => location.reload(),
    onEnter: async () => {
      player.lock(); // must happen inside the click
      hideStart();
      hud.loading('Opening the building…');
      try {
        await (worldPromise || Promise.reject(new Error('No organization connected')));
      } catch (e) {
        hud.loading(null);
        player.unlock();
        // keep the reason on the title screen (e.g. a missing GitHub App permission), not just in a toast
        renderStart(status, { ...startOptions, error: `Couldn't open the building: ${e.message}`, needsSubscription: e.needsSubscription });
        if (!status.hosted) hud.toast(`Couldn't load the organization: ${e.message}`, 'error', 9000);
        return;
      }
      attract = false;
      entered = true;
      mountFloor(0, null);
      hud.loading(null);
      hud.showHud(true);
      startPolling();
      startLive();
      if (app.isDemo) hud.toast(status.hosted ? '🎭 Demo company with fictional data. Sign in with GitHub to see your real org.' : '🎭 Demo company with fictional data. Connect the GitHub CLI to see your real org.', 'info', 7000);
      hud.toast('👋 Take the elevator (behind you) to visit a repo — or walk east to the Manager\'s Office.', 'info', 8000);
      announceEmptyBuilding();
      announceBilling();
    },
  };
  renderStart(status, startOptions);
  if (worldPromise && status.hosted) {
    worldPromise.catch((e) => {
      if (!entered) renderStart(status, { ...startOptions, error: e.needsSubscription ? e.message : `Couldn't open the building: ${e.message}`, needsSubscription: e.needsSubscription });
    });
  }
}

/** Subscription news worth saying out loud when you walk in. */
function announceBilling() {
  const b = app.world.access && app.world.access.billing;
  if (!b) return;
  if (b.pastDue && app.world.access.canManage) hud.toast("⚠️ The last payment for this building failed. It stays open while Stripe retries. Update the card from the title screen's plan card.", 'warn', 12000);
  if (b.bonus) hud.toast(`🎁 Your personal building is free thanks to ${b.via}'s Worktown3D plan.`, 'success', 8000);
}

/** A building with no floors looks broken, so say why. */
function announceEmptyBuilding() {
  const w = app.world;
  if (w.floors.length) return;
  if (!w.repos.length) {
    hud.toast(`🏗️ ${w.owner.login} has no repositories you can see yet, so there are no floors. Create one from the Manager's Office.`, 'warn', 12000);
  } else {
    hud.toast("🏗️ No repositories have a floor yet. An org owner can pick them in the Manager's Office console.", 'warn', 12000);
  }
}

// ------------------------------------------------------------------ main loop
const clock = new THREE.Clock();
let t = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  if (app.floor) {
    if (attract && !entered) {
      const W = app.floor.bounds.W;
      camera.position.set(-W / 2 + 4 + Math.sin(t * 0.08) * 3, 2.6, 6 + Math.cos(t * 0.1) * 2);
      camera.rotation.set(-0.12, -1.25 + Math.sin(t * 0.07) * 0.35, 0, 'YXZ');
    } else {
      player.update(dt);
    }
    app.floor.update(dt, t, camera);
    remote.update(dt, t, camera, settings.nameTags);
    if (entered && !riding && app.live) app.live.sendPosition(app.currentRepo(), camera.position.x, camera.position.z, camera.rotation.y);
    if (entered && player.active && !uiBlocked() && !riding) {
      currentHint = interactor.update();
      hud.setHint(currentHint ? currentHint.label : null);
    } else if (currentHint) {
      currentHint = null;
      hud.setHint(null);
    }
  }
  renderFrame();
}

applySettings();
boot();
frame();
