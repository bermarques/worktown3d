// The passport (phone → Me): design the character that represents you, PEAK style. Pick a tab, tap a swatch or an
// option, and the character on the left page changes as you go. Saving keeps it with your GitHub account, so it's
// yours in every building and every session: at your desk, and when you walk around live.
import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { api } from '../api.js';
import { cylinder, disposeTree, mesh, toon } from '../engine/toon.js';
import { Character, OPTIONS, PALETTES, characterOf, defaultLook } from '../world/character.js';
import { h } from './dom.js';
import { blip, hud } from './hud.js';
import { openModal } from './modal.js';

const TABS = [
  { id: 'skin', icon: '🎨', label: 'Skin', parts: [{ key: 'skin', title: 'Skin tone' }] },
  { id: 'eyes', icon: '👀', label: 'Eyes', parts: [{ key: 'eyes', title: 'Eyes' }, { key: 'eyeColor', title: 'Eye color' }] },
  { id: 'clothes', icon: '👕', label: 'Clothes', parts: [{ key: 'shirt', title: 'Shirt' }, { key: 'pants', title: 'Pants' }] },
  {
    id: 'accessories',
    icon: '🎩',
    label: 'Accessories',
    parts: [
      { key: 'headwear', title: 'On your head' },
      { key: 'glasses', title: 'Glasses' },
      { key: 'hairStyle', title: 'Hair' },
      { key: 'hair', title: 'Hair color' },
    ],
  },
];

const NAMES = {
  hairStyle: { short: '💇 Short', spiky: '⚡ Spiky', bun: '🍡 Bun', long: '💁 Long', curly: '🌀 Curly', bald: '🥚 Bald' },
  eyes: { round: '👀 Round', dots: '⚫ Dots', happy: '😊 Happy', sleepy: '😴 Sleepy', big: '😳 Big' },
  glasses: { none: '🚫 None', round: '👓 Round', square: '🤓 Square', shades: '😎 Shades' },
  headwear: { none: '🚫 Nothing', headphones: '🎧 Headphones', cap: '🧢 Cap', beanie: '🧶 Beanie', party: '🥳 Party hat' },
};

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

/** A character standing on the stage: no desk, no coffee breaks, just breathing and blinking. */
class PreviewCharacter extends Character {
  constructor(login, character) {
    super({ login, name: null, status: 'idle', current: null }, { seat: { x: 0, z: 0, rotY: 0 }, floor: null, character });
    this.state = 'preview';
    this.sit = 0;
    this.tag.visible = false;
  }

  update(dt, t) {
    this.animate(dt, t, false, 0);
  }
}

/** The left page: your character turning slowly on a little stage (drag to turn it yourself). */
class Preview {
  constructor(canvas, login) {
    this.canvas = canvas;
    this.login = login;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.effect = new OutlineEffect(this.renderer, { defaultThickness: 0.004, defaultColor: [0.1, 0.09, 0.15], defaultAlpha: 1 });
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#d8c3a5', 1.6), new THREE.AmbientLight('#ffffff', 0.4));
    const sun = new THREE.DirectionalLight('#fff3dd', 1.6);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    mesh(cylinder(0.62, 0.68, 0.08, 40), toon('#ffd43b'), { y: -0.04, parent: this.scene });
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    this.camera.position.set(0, 1.15, 4.4);
    this.camera.lookAt(0, 0.95, 0);
    this.clock = new THREE.Clock();
    this.t = 0;
    this.angle = 0.45;
    this.spinning = true;
    this.drag = null;

    canvas.addEventListener('pointerdown', (e) => {
      this.drag = e.clientX;
      this.spinning = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      this.angle += (e.clientX - this.drag) * 0.012;
      this.drag = e.clientX;
    });
    const release = () => {
      this.drag = null;
      clearTimeout(this.resume);
      this.resume = setTimeout(() => (this.spinning = true), 2500);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  show(character) {
    this.removeCharacter();
    this.ch = new PreviewCharacter(this.login, character);
    this.ch.root.rotation.y = this.angle;
    this.scene.add(this.ch.root);
  }

  start() {
    const frame = () => {
      // The modal has no close hook for its content: stop once the canvas has left the page.
      if (!this.canvas.isConnected) return this.dispose();
      requestAnimationFrame(frame);
      this.draw();
    };
    requestAnimationFrame(frame);
  }

  draw() {
    const { clientWidth: w, clientHeight: hgt } = this.canvas;
    if (!w || !hgt) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== hgt) {
      this.renderer.setSize(w, hgt, false);
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    }
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.t += dt;
    if (this.spinning) this.angle += dt * 0.5;
    if (this.ch) {
      this.ch.root.rotation.y = this.angle;
      this.ch.update(dt, this.t);
    }
    this.effect.render(this.scene, this.camera);
  }

  removeCharacter() {
    if (!this.ch) return;
    this.scene.remove(this.ch.root);
    this.ch.dispose();
    disposeTree(this.ch.root);
    this.ch = null;
  }

  dispose() {
    clearTimeout(this.resume);
    this.removeCharacter();
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/**
 * Open the passport for the signed-in person.
 * @param {object} app  shared app state (viewerLogin(), myCharacter)
 * @param {{ onSaved: (character: object|null) => void }} hooks  onSaved: what was saved (null: the default look)
 */
export function openCustomizer(app, { onSaved }) {
  const login = app.viewerLogin();
  const fallback = () => characterOf(defaultLook(login));
  const draft = { ...(app.myCharacter || fallback()) };
  // Saving the look drawn from the login stores nothing: it keeps following the login's default.
  let usesDefault = !app.myCharacter;
  let tab = TABS[0].id;

  const canvas = h('canvas', { class: 'pp-canvas', 'aria-label': 'Your character: drag to turn it' });
  const preview = new Preview(canvas, login);
  const tabs = h('div', { class: 'pp-tabs', role: 'tablist' });
  const options = h('div', { class: 'pp-options' });
  const saveBtn = h('button', { class: 'btn primary', onClick: () => save() }, 'Save');

  function change(patch, { isDefault = false } = {}) {
    Object.assign(draft, patch);
    usesDefault = isDefault;
    preview.show(draft);
    blip(1046);
    renderOptions();
  }

  function renderTabs() {
    tabs.replaceChildren(
      ...TABS.map((t) =>
        h(
          'button',
          {
            class: `pp-tab ${t.id === tab ? 'on' : ''}`,
            role: 'tab',
            'aria-selected': String(t.id === tab),
            onClick: () => {
              tab = t.id;
              renderTabs();
              renderOptions();
            },
          },
          h('span', { class: 'pp-tab-icon' }, t.icon),
          h('span', null, t.label),
        ),
      ),
    );
  }

  const swatches = (key) =>
    h(
      'div',
      { class: 'pp-swatches' },
      PALETTES[key].map((color) =>
        h('button', {
          class: `pp-swatch ${draft[key] === color ? 'on' : ''}`,
          style: { background: color },
          title: color,
          'aria-label': color,
          'aria-pressed': String(draft[key] === color),
          onClick: () => change({ [key]: color }),
        }),
      ),
    );

  const choices = (key) =>
    h(
      'div',
      { class: 'pp-choices' },
      OPTIONS[key].map((value) =>
        h('button', { class: `pp-choice ${draft[key] === value ? 'on' : ''}`, 'aria-pressed': String(draft[key] === value), onClick: () => change({ [key]: value }) }, NAMES[key][value]),
      ),
    );

  function renderOptions() {
    const current = TABS.find((t) => t.id === tab);
    options.replaceChildren(...current.parts.map(({ key, title }) => h('section', { class: 'pp-part' }, h('h4', null, title), PALETTES[key] ? swatches(key) : choices(key))));
  }

  function surprise() {
    const patch = {};
    for (const [key, colors] of Object.entries(PALETTES)) patch[key] = pickOne(colors);
    for (const [key, values] of Object.entries(OPTIONS)) patch[key] = pickOne(values);
    change(patch);
  }

  async function save() {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const { character } = usesDefault ? await api.resetCharacter() : await api.saveCharacter(draft);
      modal.close({ resume: true });
      hud.toast(character ? '✨ Looking good! That’s you now, in every building.' : '↺ Back to your default look.', 'success');
      onSaved(character);
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      hud.toast(`⚠️ ${e.message}`, 'error', 7000);
    }
  }

  const node = h(
    'div',
    { class: 'passport' },
    h(
      'div',
      { class: 'pp-page pp-portrait' },
      h('div', { class: 'pp-stage' }, canvas, h('span', { class: 'pp-hint' }, '↔ drag to turn')),
      h('div', { class: 'pp-name' }, `@${login}`),
      h(
        'div',
        { class: 'row pp-tools' },
        h('button', { class: 'btn small', onClick: surprise }, '🎲 Surprise me'),
        h('button', { class: 'btn small ghost', onClick: () => change(fallback(), { isDefault: true }) }, '↺ My default look'),
      ),
    ),
    h('div', { class: 'pp-page pp-wardrobe' }, tabs, options, h('div', { class: 'row end pp-actions' }, h('button', { class: 'btn ghost', onClick: () => modal.close({ resume: true }) }, 'Cancel'), saveBtn)),
  );

  const modal = openModal({ title: 'Passport', icon: '🛂', subtitle: 'How you look in every building, to everyone', wide: true, className: 'passport-modal', body: node });
  renderTabs();
  renderOptions();
  preview.show(draft);
  preview.start();
  return modal;
}
