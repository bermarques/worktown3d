// Procedural cartoon developer: big head, bean body, simple joint rig, typing / walking / coffee-break behaviour.
import * as THREE from 'three';
import { toon, sphere, capsule, cylinder, cone, torus, roundedBox, mesh, noOutline, hitMaterial, box, screenMaterial } from '../engine/toon.js';
import { mergeSiblings, trimShadows } from '../engine/merge.js';
import { hash, seeded, makeCanvas, canvasTexture, drawAvatar, fitText, FONT, personColor, fillRound } from '../engine/canvas.js';

// Looks drawn from a login pick from these (keep them as they are, or everyone's default look changes).
const SKIN = ['#ffdbc4', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffe0bd', '#f6d1b8'];
const SHIRTS = ['#4dabf7', '#ff6b6b', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#38d9a9', '#748ffc', '#f783ac', '#ffffff', '#343a40'];
const PANTS = ['#364fc7', '#495057', '#5c3d2e', '#2b8a3e', '#212529', '#1864ab'];
const HAIR = ['#2b1d14', '#5a3825', '#a0642f', '#e6c36a', '#d9480f', '#1a1a1a', '#868e96', '#e64980', '#4c6ef5'];
const EYE_DEFAULT = '#1b1b24';

/** What a character can be customized with. The API accepts the same option names (and any #rrggbb color). */
export const OPTIONS = {
  hairStyle: ['short', 'spiky', 'bun', 'long', 'curly', 'bald'],
  eyes: ['round', 'dots', 'happy', 'sleepy', 'big'],
  glasses: ['none', 'round', 'square', 'shades'],
  headwear: ['none', 'headphones', 'cap', 'beanie', 'party'],
};

/** Colors offered in the customizer. */
export const PALETTES = {
  skin: [...SKIN, '#fbe3d6', '#a86b3c', '#6b3e26', '#3b2219', '#b4e3a8', '#a5d8ff'],
  hair: [...HAIR, '#f8f0e3', '#2f9e44', '#ae3ec9'],
  eyeColor: [EYE_DEFAULT, '#5a3825', '#1864ab', '#2b8a3e', '#5f3dc4', '#c92a2a', '#868e96'],
  shirt: [...SHIRTS, '#fa5252', '#1864ab', '#2b8a3e', '#e8590c'],
  pants: [...PANTS, '#868e96', '#f8f0e3', '#c92a2a', '#5f3dc4'],
};

const damp = (current, target, k, dt) => current + (target - current) * (1 - Math.exp(-k * dt));
const STAND_Y = 0.63;
const SIT_Y = 0.45;

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = ['skin', 'hair', 'eyeColor', 'shirt', 'pants'];
const OLD_HAIR = ['short', 'spiky', 'bun', 'long', 'beanie', 'curly', 'bald'];

/** The look drawn from a login: stable for each person, with similar logins spread across the options. */
export function defaultLook(login) {
  const r = seeded(hash(login));
  const pick = (list) => list[Math.floor(r() * list.length)];
  const skin = pick(SKIN);
  const shirt = pick(SHIRTS);
  const pants = pick(PANTS);
  const hair = pick(HAIR);
  const hairStyle = OLD_HAIR[Math.floor(r() * 7)];
  const glasses = r() < 0.35 ? 'round' : 'none';
  const headphones = r() < 0.15;
  const height = 0.95 + r() * 0.1;
  return {
    skin,
    shirt,
    pants,
    hair,
    hairStyle: hairStyle === 'beanie' ? 'short' : hairStyle,
    eyes: 'round',
    eyeColor: EYE_DEFAULT,
    glasses,
    headwear: hairStyle === 'beanie' ? 'beanie' : headphones ? 'headphones' : 'none',
    height,
  };
}

/** The parts of a saved character (from the API) to draw; anything missing or unknown keeps the default look. */
export function customLook(character) {
  const out = {};
  if (!character || typeof character !== 'object') return out;
  for (const key of COLOR_KEYS) if (typeof character[key] === 'string' && HEX.test(character[key])) out[key] = character[key];
  for (const [key, options] of Object.entries(OPTIONS)) if (options.includes(character[key])) out[key] = character[key];
  return out;
}

/** Someone's look: their saved character over the look drawn from their login. */
export const lookOf = (login, character) => ({ ...defaultLook(login), ...customLook(character) });

/** A look as a character to save (the API's shape: no height, which stays the one drawn from the login). */
export function characterOf(look) {
  const out = {};
  for (const key of [...COLOR_KEYS, ...Object.keys(OPTIONS)]) out[key] = look[key];
  return out;
}

function joint(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

export class Character {
  /**
   * @param {object} dev   floor dev model ({login, name, status, current, ...})
   * @param {object} opts  { seat: {x, z, rotY}, floor, character }  floor provides pathToCoffee()/coffeeSpot();
   *                       character: their saved character (see customLook), when they designed one
   */
  constructor(dev, { seat, floor, character = null }) {
    this.dev = dev;
    this.login = dev.login;
    this.seat = seat;
    this.floor = floor;
    this.character = character || null;
    this.rand = seeded(hash(dev.login) ^ 0x9e3779b9);
    this.look = lookOf(dev.login, character);

    this.root = new THREE.Group();
    this.root.userData.dynamic = true;
    this.root.position.set(seat.x, 0, seat.z);
    this.root.rotation.y = seat.rotY;
    this.root.scale.setScalar(this.look.height);
    this.body = joint(this.root, 0, SIT_Y, 0);
    this.build();

    // behaviour
    this.state = 'desk';
    this.timer = 4 + this.rand() * 20;
    this.path = [];
    this.pathIndex = 0;
    this.sit = 1;
    this.walkPhase = 0;
    this.walkBlend = 0;
    this.blinkTimer = 1 + this.rand() * 4;
    this.typingSpeed = 14 + this.rand() * 8;
    this.lookTarget = 0;
    this.sipTimer = 3;
    this.awayChanged = true; // tells the floor to redraw the laptop (lock screen vs. work)
    this.updateTag();
  }

  get away() {
    return this.state !== 'desk';
  }

  build() {
    const L = this.look;
    const skin = toon(L.skin);
    const shirt = toon(L.shirt);
    const pants = toon(L.pants);
    const hair = toon(L.hair);
    const dark = toon('#2b2d3a');

    // legs
    this.legs = [-0.11, 0.11].map((x) => {
      const hip = joint(this.body, x, 0, 0);
      mesh(capsule(0.085, 0.14), pants, { y: -0.15, parent: hip });
      const knee = joint(hip, 0, -0.3, 0);
      mesh(capsule(0.075, 0.12), pants, { y: -0.13, parent: knee });
      mesh(roundedBox(0.14, 0.08, 0.24, 0.035), dark, { y: -0.29, z: 0.04, parent: knee });
      return { hip, knee };
    });

    // pelvis + torso
    mesh(sphere(0.2, 16, 10), pants, { y: 0.02, sy: 0.55, sz: 0.8, parent: this.body });
    this.torso = mesh(capsule(0.2, 0.26), shirt, { y: 0.32, sx: 1.05, sz: 0.8, parent: this.body });

    // ID badge with the GitHub avatar
    const { canvas, ctx } = makeCanvas(96, 120);
    this.badgeCanvas = { canvas, ctx };
    this.badgeTex = canvasTexture(canvas);
    this.drawBadge();
    mesh(box(0.1, 0.125, 0.004), screenMaterial(this.badgeTex), { x: 0.09, y: 0.38, z: 0.168, rx: -0.12, cast: false, parent: this.body });

    // arms
    this.arms = [-1, 1].map((side) => {
      const shoulder = joint(this.body, side * 0.25, 0.52, 0);
      shoulder.rotation.z = side * 0.12;
      mesh(capsule(0.065, 0.14), shirt, { y: -0.13, parent: shoulder });
      const elbow = joint(shoulder, 0, -0.27, 0);
      mesh(capsule(0.06, 0.12), skin, { y: -0.12, parent: elbow });
      const hand = mesh(sphere(0.07, 12, 10), skin, { y: -0.26, parent: elbow });
      return { shoulder, elbow, hand, side };
    });
    // coffee mug lives in the right hand
    this.mug = mesh(cylinder(0.05, 0.045, 0.11, 12), toon('#ffffff'), { y: -0.3, z: 0.05, parent: this.arms[1].elbow });
    mesh(torus(0.03, 0.01, 6, 12), toon('#ffffff'), { x: 0.05, parent: this.mug });
    this.mug.visible = false;

    // head
    this.neck = joint(this.body, 0, 0.66, 0);
    this.head = joint(this.neck, 0, 0.22, 0);
    mesh(sphere(0.27, 24, 18), skin, { parent: this.head });
    for (const s of [-1, 1]) mesh(sphere(0.06, 10, 8), skin, { x: s * 0.265, y: -0.01, parent: this.head });
    mesh(sphere(0.032, 10, 8), toon(new THREE.Color(L.skin).offsetHSL(0, 0.05, -0.08)), { y: -0.03, z: 0.27, parent: this.head });

    this.buildEyes(skin);
    mesh(torus(0.06, 0.013, 6, 16, Math.PI), noOutline(new THREE.MeshBasicMaterial({ color: '#7a2e2e' })), { y: -0.095, z: 0.245, rz: Math.PI, rx: -0.25, parent: this.head });
    const blush = noOutline(new THREE.MeshBasicMaterial({ color: '#ff8fa3', transparent: true, opacity: 0.55 }));
    for (const s of [-1, 1]) mesh(sphere(0.042, 10, 8), blush, { x: s * 0.17, y: -0.055, z: 0.2, sz: 0.4, ry: s * 0.6, cast: false, parent: this.head });

    this.buildHair(hair);
    this.buildGlasses();
    this.buildHeadwear();

    // name tag (sprite)
    const tag = makeCanvas(512, 128);
    this.tagCanvas = tag;
    this.tagTex = canvasTexture(tag.canvas);
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false }));
    this.tag.scale.set(0.92, 0.23, 1);
    this.tag.position.set(0, 1.98, 0);
    this.tag.renderOrder = 10;
    this.root.add(this.tag);

    // interaction hit box
    this.hitbox = new THREE.Mesh(box(0.7, 1.7, 0.7), hitMaterial);
    this.hitbox.position.y = 0.85;
    this.hitbox.userData.character = this;
    this.root.add(this.hitbox);

    mergeSiblings(this.root);
    trimShadows(this.root, 0.06);
  }

  buildEyes(skin) {
    const style = this.look.eyes;
    const pupil = noOutline(new THREE.MeshBasicMaterial({ color: this.look.eyeColor }));
    const white = noOutline(toon('#ffffff').clone());
    const shine = noOutline(new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    this.eyes = [-1, 1].map((s) => {
      const eye = joint(this.head, s * 0.1, 0.035, 0.225);
      if (style === 'dots') {
        mesh(sphere(0.034, 12, 8), pupil, { z: 0.035, sz: 0.6, parent: eye });
      } else if (style === 'happy') {
        // closed, smiling eyes: little arches
        mesh(torus(0.038, 0.012, 6, 14, Math.PI), pupil, { y: -0.012, z: 0.04, parent: eye });
      } else {
        const k = style === 'big' ? 1.25 : 1;
        mesh(sphere(0.07 * k, 14, 10), white, { sz: 0.55, parent: eye });
        mesh(sphere(0.042 * k, 12, 8), pupil, { z: 0.03, parent: eye });
        mesh(sphere(0.013 * k, 6, 6), shine, { x: -0.015 * k, y: 0.018 * k, z: 0.065, parent: eye });
        // heavy eyelids over the top half
        if (style === 'sleepy') mesh(new THREE.SphereGeometry(0.076, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), skin, { y: 0.004, z: 0.006, sz: 0.62, rx: 0.3, parent: eye });
      }
      return eye;
    });
  }

  buildGlasses() {
    const style = this.look.glasses;
    if (style === 'none') return;
    const frame = noOutline(new THREE.MeshBasicMaterial({ color: '#1b1b24' }));
    const lens = style === 'shades' ? noOutline(new THREE.MeshBasicMaterial({ color: '#212529' })) : null;
    for (const s of [-1, 1]) {
      // a 4-sided torus, turned 45°, is a square frame
      if (style === 'square') mesh(torus(0.08, 0.011, 4, 4), frame, { x: s * 0.1, y: 0.035, z: 0.262, rz: Math.PI / 4, parent: this.head });
      else mesh(torus(0.065, 0.011, 6, 18), frame, { x: s * 0.1, y: 0.035, z: 0.262, parent: this.head });
      if (lens) mesh(cylinder(0.062, 0.062, 0.006, 18), lens, { x: s * 0.1, y: 0.035, z: 0.264, rx: Math.PI / 2, parent: this.head });
    }
    mesh(box(0.07, 0.014, 0.014), frame, { y: 0.05, z: 0.27, parent: this.head });
  }

  buildHeadwear() {
    const head = this.head;
    switch (this.look.headwear) {
      case 'headphones': {
        const hp = toon('#212529');
        mesh(torus(0.29, 0.025, 6, 20, Math.PI), hp, { y: 0.0, parent: head });
        for (const s of [-1, 1]) mesh(cylinder(0.08, 0.08, 0.06, 14), toon(personColor(this.login)), { x: s * 0.29, rz: Math.PI / 2, parent: head });
        break;
      }
      case 'beanie': {
        const hat = toon(personColor(this.login + 'hat'));
        mesh(new THREE.SphereGeometry(0.295, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hat, { y: 0.03, parent: head });
        mesh(torus(0.27, 0.045, 8, 24), hat, { y: 0.06, rx: Math.PI / 2, parent: head });
        mesh(sphere(0.07, 10, 8), toon('#ffffff'), { y: 0.33, parent: head });
        break;
      }
      case 'cap': {
        const cap = toon(personColor(this.login + 'cap'));
        mesh(new THREE.SphereGeometry(0.3, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), cap, { y: 0.04, parent: head });
        mesh(cylinder(0.17, 0.17, 0.022, 20), cap, { y: 0.125, z: 0.25, sz: 0.85, rx: 0.1, parent: head });
        mesh(sphere(0.03, 8, 6), cap, { y: 0.34, parent: head });
        break;
      }
      case 'party': {
        mesh(cone(0.12, 0.34, 16), toon(personColor(this.login + 'party')), { x: 0.01, y: 0.41, rz: -0.12, parent: head });
        mesh(sphere(0.05, 10, 8), toon('#ffffff'), { x: 0.03, y: 0.58, parent: head });
        break;
      }
    }
  }

  buildHair(mat) {
    const head = this.head;
    // Under a cap or a beanie, only the hair that shows below it is drawn.
    const covered = this.look.headwear === 'cap' || this.look.headwear === 'beanie';
    const style = covered && !['long', 'bald'].includes(this.look.hairStyle) ? 'short' : this.look.hairStyle;
    const dome = () => mesh(new THREE.SphereGeometry(0.29, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), mat, { y: 0.015, rx: -0.3, parent: head });
    switch (style) {
      case 'short':
        dome();
        break;
      case 'spiky':
        dome();
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          mesh(cone(0.07, 0.2, 8), mat, { x: Math.cos(a) * 0.14, y: 0.25, z: Math.sin(a) * 0.14 - 0.03, rx: Math.sin(a) * 0.5, rz: -Math.cos(a) * 0.5, parent: head });
        }
        break;
      case 'bun':
        dome();
        mesh(sphere(0.12, 14, 10), mat, { y: 0.27, z: -0.12, parent: head });
        break;
      case 'long':
        if (!covered) dome();
        mesh(roundedBox(0.54, 0.5, 0.16, 0.07), mat, { y: -0.14, z: -0.18, parent: head });
        break;
      case 'curly':
        for (let i = 0; i < 11; i++) {
          const a = (i / 11) * Math.PI * 2;
          mesh(sphere(0.1, 10, 8), mat, { x: Math.cos(a) * 0.19, y: 0.18 + (i % 2) * 0.05, z: Math.sin(a) * 0.19 - 0.04, parent: head });
        }
        mesh(sphere(0.16, 12, 10), mat, { y: 0.24, z: -0.03, parent: head });
        break;
      default: // bald with a little tuft
        if (!covered) mesh(sphere(0.05, 8, 6), mat, { y: 0.28, z: 0.05, parent: head });
    }
  }

  drawBadge() {
    const { ctx } = this.badgeCanvas;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 96, 120);
    ctx.fillStyle = personColor(this.login);
    ctx.fillRect(0, 0, 96, 22);
    drawAvatar(ctx, this.login, 48, 62, 30, { ring: '#ffffff' });
    ctx.fillStyle = '#1b1b24';
    ctx.font = `800 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, this.login, 90), 48, 106);
    this.badgeTex.needsUpdate = true;
  }

  statusLine() {
    const c = this.dev.current;
    if (this.state === 'coffee' || this.state === 'toCoffee') return '☕ coffee break';
    if (this.state === 'toDesk') return '🚶 heading back';
    if (!c) return '💤 nothing assigned';
    if (c.kind === 'issue') return `🔨 working on #${c.number}`;
    if (c.kind === 'pr') return c.ready ? `🚀 PR #${c.number} ready` : c.isDraft ? `📝 drafting PR #${c.number}` : `👀 PR #${c.number} in review`;
    return `✅ shipped #${c.number}`;
  }

  updateTag() {
    const { ctx } = this.tagCanvas;
    ctx.clearRect(0, 0, 512, 128);
    fillRound(ctx, 6, 8, 500, 112, 56, 'rgba(255,255,255,0.96)', '#1b1b24', 5);
    drawAvatar(ctx, this.login, 62, 64, 42, { ring: personColor(this.login), ringWidth: 6 });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#1b1b24';
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText(fitText(ctx, '@' + this.login, 380), 118, 58);
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = '#5c5f73';
    ctx.fillText(fitText(ctx, this.statusLine(), 380), 118, 98);
    this.tagTex.needsUpdate = true;
  }

  setDev(dev) {
    const prevStatus = this.statusLine();
    this.dev = dev;
    this.drawBadge();
    if (this.statusLine() !== prevStatus) this.updateTag();
  }

  refreshAvatar() {
    this.drawBadge();
    this.updateTag();
  }

  // ------------------------------------------------------------ behaviour
  setState(state) {
    this.state = state;
    this.awayChanged = true;
    this.updateTag();
  }

  decideAtDesk() {
    const working = this.dev.status === 'working';
    const chance = working ? 0.15 : 0.55;
    if (this.floor && this.rand() < chance) {
      const path = this.floor.pathToCoffee(this);
      if (path && path.length) {
        this.path = path;
        this.pathIndex = 0;
        this.setState('toCoffee');
        return;
      }
    }
    this.timer = (working ? 25 : 10) + this.rand() * 30;
  }

  followPath(dt) {
    const target = this.path[this.pathIndex];
    if (!target) return true;
    const p = this.root.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    const speed = 1.25 * (this.sit > 0.3 ? 0.4 : 1);
    if (dist < 0.05) {
      this.pathIndex++;
      return this.pathIndex >= this.path.length;
    }
    const step = Math.min(dist, speed * dt);
    p.x += (dx / dist) * step;
    p.z += (dz / dist) * step;
    const want = Math.atan2(dx, dz);
    let diff = want - this.root.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.root.rotation.y += diff * (1 - Math.exp(-10 * dt));
    return false;
  }

  update(dt, t) {
    let walking = false;
    let targetSit = 0;
    switch (this.state) {
      case 'desk':
        targetSit = 1;
        this.timer -= dt;
        if (this.timer <= 0) this.decideAtDesk();
        break;
      case 'toCoffee':
        walking = true;
        if (this.followPath(dt)) {
          this.setState('coffee');
          this.timer = 18 + this.rand() * 30;
          this.facing = this.floor ? this.floor.coffeeFacing(this.root.position) : this.root.rotation.y;
        }
        break;
      case 'coffee':
        this.timer -= dt;
        if (this.facing !== undefined) {
          let diff = this.facing - this.root.rotation.y;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          this.root.rotation.y += diff * (1 - Math.exp(-4 * dt));
        }
        if (this.timer <= 0) {
          this.path = this.floor.pathBackToDesk(this);
          this.pathIndex = 0;
          this.setState('toDesk');
        }
        break;
      case 'toDesk':
        walking = true;
        if (this.followPath(dt)) {
          this.root.position.set(this.seat.x, 0, this.seat.z);
          this.root.rotation.y = this.seat.rotY;
          this.setState('desk');
          this.timer = 30 + this.rand() * 60;
        }
        break;
    }
    this.animate(dt, t, walking, targetSit);
  }

  animate(dt, t, walking, targetSit) {
    this.sit = damp(this.sit, targetSit, 6, dt);
    this.walkBlend = damp(this.walkBlend, walking ? 1 : 0, 8, dt);
    if (walking) this.walkPhase += dt * 9;
    const sit = this.sit;
    const wb = this.walkBlend;
    const ph = this.walkPhase;
    const k = 14;

    const bob = Math.abs(Math.sin(ph)) * 0.04 * wb + Math.sin(t * 1.6 + this.typingSpeed) * 0.006;
    this.body.position.y = THREE.MathUtils.lerp(STAND_Y, SIT_Y, sit) + bob;

    this.legs.forEach((leg, i) => {
      const swing = Math.sin(ph + i * Math.PI) * 0.6 * wb;
      const kneeBend = Math.max(0, -Math.sin(ph + i * Math.PI)) * 0.7 * wb;
      leg.hip.rotation.x = damp(leg.hip.rotation.x, THREE.MathUtils.lerp(swing, -Math.PI / 2, sit), k, dt);
      leg.knee.rotation.x = damp(leg.knee.rotation.x, THREE.MathUtils.lerp(kneeBend, Math.PI / 2, sit), k, dt);
    });

    const atDesk = this.state === 'desk';
    const working = this.dev.status === 'working';
    const holdingMug = this.state === 'coffee' || this.state === 'toDesk';
    this.mug.visible = holdingMug;

    this.arms.forEach((arm, i) => {
      let sx;
      let ex;
      if (atDesk && sit > 0.5) {
        const speed = working ? this.typingSpeed : 4;
        const amp = working ? 0.1 : 0.04;
        sx = -0.62 + Math.sin(t * speed * 0.5 + i * 2) * 0.03;
        ex = -0.95 + Math.sin(t * speed + i * 1.7) * amp;
      } else if (holdingMug && arm.side === 1) {
        const sip = this.state === 'coffee' && Math.sin(t * 0.7 + this.typingSpeed) > 0.85;
        sx = sip ? -0.9 : -0.35;
        ex = sip ? -1.9 : -1.35;
      } else {
        sx = -Math.sin(ph + i * Math.PI) * 0.55 * wb + Math.sin(t * 1.3 + i) * 0.04;
        ex = -0.15 - 0.2 * wb;
        if (this.state === 'coffee' && arm.side === -1) {
          // gesture while chatting
          sx = -0.4 + Math.sin(t * 2.1 + this.typingSpeed) * 0.25;
          ex = -0.8;
        }
      }
      arm.shoulder.rotation.x = damp(arm.shoulder.rotation.x, sx, k, dt);
      arm.elbow.rotation.x = damp(arm.elbow.rotation.x, ex, k, dt);
    });

    // head: look down at the laptop while working, glance around otherwise
    let headX = 0;
    let headY = 0;
    if (atDesk && sit > 0.5) {
      headX = working ? 0.28 + Math.sin(t * 1.1 + this.typingSpeed) * 0.03 : 0.12;
      headY = working ? Math.sin(t * 0.37 + this.typingSpeed) * 0.08 : Math.sin(t * 0.25 + this.typingSpeed) * 0.5;
    } else if (this.state === 'coffee') {
      headY = Math.sin(t * 0.5 + this.typingSpeed) * 0.5;
      headX = -0.05;
    }
    this.head.rotation.x = damp(this.head.rotation.x, headX, 6, dt);
    this.head.rotation.y = damp(this.head.rotation.y, headY, 4, dt);

    // blink
    this.blinkTimer -= dt;
    const blinking = this.blinkTimer < 0.12;
    if (this.blinkTimer < 0) this.blinkTimer = 2 + this.rand() * 4;
    for (const e of this.eyes) e.scale.y = blinking ? 0.12 : 1;

    this.tag.position.y = THREE.MathUtils.lerp(1.98, 1.78, sit);
  }

  dispose() {
    this.badgeTex.dispose();
    this.tagTex.dispose();
    this.tag.material.dispose();
  }
}
