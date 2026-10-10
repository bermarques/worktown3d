// One floor per repository: desk pods for current contributors, the team Kanban board, a coffee corner.
import * as THREE from 'three';
import { toon, roundedBox, box, cone, torus, mesh, hitMaterial, disposeTree } from '../engine/toon.js';
import { makeCanvas, canvasTexture, personColor, hash, FONT, DISPLAY_FONT } from '../engine/canvas.js';
import { buildRoom, Elevator, collider, colliderFromObject, WALL_T, CEILING } from './building.js';
import { workstation, plant, couch, coffeeTable, standingTable, coffeeCounter, waterCooler, rug, wallBoard, trashBin, bookshelf } from './furniture.js';
import { Character } from './character.js';
import { mergeStatic, trimShadows } from '../engine/merge.js';
import { drawLaptop, drawKanban, drawFloorSign, LAPTOP_W, LAPTOP_H } from './screens.js';

const POD_SPACING_X = 4.8;
const POD_SPACING_Z = 4.9;
const SEAT_OFFSET_Z = 1.0;
// Busiest people get desks; beyond this the floor would get too heavy to render smoothly.
export const MAX_SEATED = 48;

const ACCENTS = ['#4dabf7', '#ff8787', '#69db7c', '#ffa94d', '#da77f2', '#38d9a9', '#748ffc', '#f783ac', '#ffd43b'];
const FLOORS = [
  ['#a5d8ff', '#93cdf7'],
  ['#b2f2bb', '#a3e8ad'],
  ['#ffd8a8', '#ffcd94'],
  ['#d0bfff', '#c3aefc'],
  ['#ffc9c9', '#ffb8b8'],
  ['#99e9f2', '#87dfea'],
];

let emptyScreenTex = null;
function emptyScreen() {
  if (emptyScreenTex) return emptyScreenTex;
  const { canvas, ctx } = makeCanvas(LAPTOP_W, LAPTOP_H);
  const g = ctx.createLinearGradient(0, 0, LAPTOP_W, LAPTOP_H);
  g.addColorStop(0, '#3b5bdb');
  g.addColorStop(1, '#5f3dc4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LAPTOP_W, LAPTOP_H);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 40px ${DISPLAY_FONT}`;
  ctx.fillText('🪑 Open seat', LAPTOP_W / 2, 135);
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText('This desk is waiting for a new teammate', LAPTOP_W / 2, 190);
  emptyScreenTex = canvasTexture(canvas);
  emptyScreenTex.userData.shared = true;
  return emptyScreenTex;
}

export class RepoFloor {
  constructor({ data, world, floorNumber, floorLabels }) {
    this.kind = 'repo';
    this.data = data;
    this.world = world;
    this.repoName = data.repo.name;
    this.floorNumber = floorNumber;
    this.floorLabel = `${floorNumber}F`;
    this.group = new THREE.Group();
    this.colliders = [];
    this.occluders = [];
    this.interactables = [];
    this.disposables = [];
    this.characters = [];
    this.showTags = true;
    this.marker = null;
    this.coffeeSpots = [];
    const h = hash(data.repo.name);
    this.accent = data.repo.languageColor || ACCENTS[h % ACCENTS.length];
    this.floorColors = FLOORS[h % FLOORS.length];
    this.build(floorLabels);
  }

  layout() {
    const seatsNeeded = Math.max(Math.min(this.data.devs.length, MAX_SEATED), 4);
    const pods = Math.ceil(seatsNeeded / 4);
    const cols = Math.min(7, Math.max(1, Math.ceil(Math.sqrt(pods * 1.6))));
    const rows = Math.ceil(pods / cols);
    const deskW = cols * POD_SPACING_X;
    const deskD = rows * POD_SPACING_Z;
    const W = Math.max(26, deskW + 14);
    const D = Math.max(20, deskD + 11);
    const xStart = -W / 2 + 8.5 + (W - 10.5 - deskW) / 2;
    const zStart = -D / 2 + 5.2 + (D - 6.7 - deskD) / 2;
    return { pods, cols, rows, deskW, deskD, W, D, xStart, zStart };
  }

  build(floorLabels) {
    const L = this.layout();
    this.L = L;
    const { W, D } = L;
    this.bounds = { W, D };

    const room = buildRoom({ width: W, depth: D, floorColors: this.floorColors, trimColor: this.accent });
    this.group.add(room.group);
    this.colliders.push(...room.colliders);
    this.occluders.push(...room.occluders);
    this.disposables.push(...room.disposables);

    this.elevator = new Elevator({ x0: -W / 2, floorLabel: this.floorLabel, floorLabels });
    this.group.add(this.elevator.group);
    this.colliders.push(...this.elevator.colliders);
    this.interactables.push(...this.elevator.interactables);

    this.buildDesks();
    this.buildBoard();
    this.buildSign();
    this.buildCoffeeCorner();
    this.buildLounge();

    trimShadows(this.group, 0.1);
    mergeStatic(this.group);

    // spawn just outside the elevator, looking into the office
    this.spawn = { x: -W / 2 + 1.6, z: 0, yaw: -Math.PI / 2 };
  }

  buildDesks() {
    const { pods, cols, xStart, zStart } = this.L;
    this.seats = [];
    for (let p = 0; p < pods; p++) {
      const c = p % cols;
      const r = Math.floor(p / cols);
      const pcx = xStart + POD_SPACING_X * (c + 0.5);
      const pcz = zStart + POD_SPACING_Z * (r + 0.5);
      for (const side of [-1, 1]) {
        for (const dx of [-0.72, 0.72]) {
          this.seats.push({ x: pcx + dx, z: pcz + side * SEAT_OFFSET_Z, rotY: side < 0 ? 0 : Math.PI, podZ: pcz, side });
        }
      }
      // pod collider covers both desks; chairs are separate so people can walk between pods
      this.colliders.push(collider(pcx - 1.45, pcx + 1.45, pcz - 0.8, pcz + 0.8));
      if (p % 3 === 1) {
        const pl = plant(1.1);
        pl.position.set(pcx + 1.95, 0, pcz);
        this.group.add(pl);
      }
    }

    const devs = this.data.devs.slice(0, MAX_SEATED);
    this.seats.forEach((seat, i) => {
      const dev = devs[i];
      let screenTex = emptyScreen();
      let laptopCanvas = null;
      if (dev) {
        laptopCanvas = makeCanvas(LAPTOP_W, LAPTOP_H);
        screenTex = canvasTexture(laptopCanvas.canvas);
        this.disposables.push(screenTex);
      }
      const ws = workstation({
        chairColor: dev ? personColor(dev.login) : '#ced4da',
        dividerColor: this.accent,
        divider: seat.side < 0,
        laptopScreen: screenTex,
      });
      ws.position.set(seat.x, 0, seat.z);
      ws.rotation.y = seat.rotY;
      this.group.add(ws);

      if (!dev) return;
      const ch = new Character(dev, { seat, floor: this, character: dev.character });
      this.group.add(ch.root);
      ch.laptop = { canvas: laptopCanvas, tex: screenTex, lastDraw: -1, mesh: ws.userData.laptop };
      ch.hitbox.userData.interact = { label: `Talk to @${dev.login}`, kind: 'dev', login: dev.login };
      this.interactables.push(ch.hitbox);
      const lapHit = mesh(box(0.7, 0.5, 0.5), hitMaterial, { y: 0.2, cast: false, receive: false, parent: ws.userData.laptop });
      lapHit.userData.interact = { label: `Read @${dev.login}'s screen`, kind: 'dev', login: dev.login };
      this.interactables.push(lapHit);
      this.characters.push(ch);
      this.drawLaptop(ch, 0);
    });
  }

  buildBoard() {
    const { W, D, xStart, deskW } = this.L;
    const BW = THREE.MathUtils.clamp(deskW + 2, 12, 16);
    const BH = 3.2;
    let bx = xStart + deskW / 2;
    bx = THREE.MathUtils.clamp(bx, -W / 2 + 7 + BW / 2, W / 2 - 0.6 - BW / 2);
    const { canvas, ctx } = makeCanvas(4096, Math.round((4096 * BH) / BW));
    this.board = { canvas, ctx, tex: canvasTexture(canvas, { anisotropy: 16 }) };
    this.disposables.push(this.board.tex);
    this.drawBoard();
    const b = wallBoard(BW, BH, this.board.tex, { frame: '#3d4155' });
    b.position.set(bx, 0.62, -D / 2 + 0.05);
    this.group.add(b);
    const face = b.userData.face;
    face.userData.interact = { label: 'Open the team board', kind: 'board' };
    this.interactables.push(face);
    this.boardPos = new THREE.Vector3(bx, 2.2, -D / 2);
  }

  drawBoard() {
    const { canvas, ctx, tex } = this.board;
    drawKanban(ctx, canvas.width, canvas.height, { data: this.data, repoName: this.repoName });
    tex.needsUpdate = true;
  }

  buildSign() {
    const { W } = this.L;
    const { canvas, ctx } = makeCanvas(1280, 720);
    this.sign = { canvas, ctx, tex: canvasTexture(canvas) };
    this.disposables.push(this.sign.tex);
    this.drawSign();
    const s = wallBoard(3.2, 1.8, this.sign.tex, { frame: '#2b2d3a', tray: false });
    s.position.set(-W / 2 + 0.05, 1.05, -3.3);
    s.rotation.y = Math.PI / 2;
    this.group.add(s);
    s.userData.face.userData.interact = { label: `About ${this.repoName}`, kind: 'repoInfo' };
    this.interactables.push(s.userData.face);
  }

  drawSign() {
    const { canvas, ctx, tex } = this.sign;
    drawFloorSign(ctx, canvas.width, canvas.height, { floorLabel: this.floorLabel, data: this.data, links: this.world.links, accent: this.accent, remote: Math.max(0, this.data.devs.length - MAX_SEATED) });
    tex.needsUpdate = true;
  }

  buildCoffeeCorner() {
    const { W, D } = this.L;
    const counter = coffeeCounter(4.2);
    counter.position.set(-W / 2 + 2.6, 0, D / 2 - 0.4);
    counter.rotation.y = Math.PI;
    this.group.add(counter);
    this.colliders.push(colliderFromObject(counter));

    const cooler = waterCooler();
    cooler.position.set(-W / 2 + 0.45, 0, D / 2 - 3.2);
    cooler.rotation.y = Math.PI / 2;
    this.group.add(cooler);
    this.colliders.push(colliderFromObject(cooler));

    this.coffeeCenter = new THREE.Vector3(-W / 2 + 3.2, 0, D / 2 - 3.4);
    const table = standingTable();
    table.position.copy(this.coffeeCenter);
    this.group.add(table);
    this.colliders.push(collider(this.coffeeCenter.x - 0.45, this.coffeeCenter.x + 0.45, this.coffeeCenter.z - 0.45, this.coffeeCenter.z + 0.45));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      this.coffeeSpots.push({ x: this.coffeeCenter.x + Math.cos(a) * 0.95, z: this.coffeeCenter.z + Math.sin(a) * 0.95, taken: null });
    }
    // a second cluster in front of the counter
    for (let i = 0; i < 3; i++) this.coffeeSpots.push({ x: -W / 2 + 1.4 + i * 1.1, z: D / 2 - 1.4, taken: null });

    const rugMesh = rug(5.4, 4.6, '#ffe3e3');
    rugMesh.position.set(-W / 2 + 3, 0, D / 2 - 2.6);
    this.group.add(rugMesh);
    const pl = plant(1.4, { tall: true });
    pl.position.set(-W / 2 + 5.6, 0, D / 2 - 0.6);
    this.group.add(pl);
    this.colliders.push(colliderFromObject(pl, -0.05));
    const bin = trashBin();
    bin.position.set(-W / 2 + 5.0, 0, D / 2 - 0.5);
    this.group.add(bin);

    this.group.add(this.textSign('☕ Coffee', -W / 2 + 2.6, 2.6, D / 2 - 0.02, Math.PI, '#e03131'));
  }

  buildLounge() {
    const { W, D } = this.L;
    const c = couch('#748ffc', 2.4);
    c.position.set(-W / 2 + 0.7, 0, -D / 2 + 3.6);
    c.rotation.y = Math.PI / 2;
    this.group.add(c);
    this.colliders.push(colliderFromObject(c));
    const t = coffeeTable(1.1, 0.6);
    t.position.set(-W / 2 + 2.1, 0, -D / 2 + 3.6);
    t.rotation.y = Math.PI / 2;
    this.group.add(t);
    this.colliders.push(colliderFromObject(t));
    const r = rug(3.2, 3.6, '#e5dbff');
    r.position.set(-W / 2 + 1.9, 0, -D / 2 + 3.6);
    this.group.add(r);
    const shelf = bookshelf(1.8, 2.0);
    shelf.position.set(-W / 2 + 3.6, 0, -D / 2 + 0.25);
    this.group.add(shelf);
    this.colliders.push(colliderFromObject(shelf));
    for (const [x, z] of [[-W / 2 + 0.7, -D / 2 + 0.7], [W / 2 - 0.7, -D / 2 + 0.7], [W / 2 - 0.7, D / 2 - 0.7]]) {
      const pl = plant(1.3, { tall: true });
      pl.position.set(x, 0, z);
      this.group.add(pl);
      this.colliders.push(colliderFromObject(pl, -0.05));
    }
  }

  textSign(text, x, y, z, rotY, color) {
    const { canvas, ctx } = makeCanvas(512, 160);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 152, 76);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 84px ${DISPLAY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 84);
    const tex = canvasTexture(canvas);
    this.disposables.push(tex);
    const m = mesh(new THREE.PlaneGeometry(1.6, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true }), { x, y, z, ry: rotY, cast: false, receive: false });
    m.material.userData.outlineParameters = { visible: false };
    return m;
  }

  // ------------------------------------------------------------ paths for the coffee-break behaviour
  pathToCoffee(ch) {
    const free = this.coffeeSpots.filter((s) => !s.taken);
    if (!free.length) return null;
    const spot = free[Math.floor(ch.rand() * free.length)];
    spot.taken = ch.login;
    ch.coffeeSpot = spot;
    const seat = ch.seat;
    const aisleZ = seat.podZ + seat.side * (POD_SPACING_Z / 2);
    const corridorX = this.L.xStart;
    return [
      { x: seat.x, z: seat.z + seat.side * 0.55 },
      { x: seat.x, z: aisleZ },
      { x: corridorX, z: aisleZ },
      { x: corridorX, z: this.coffeeCenter.z },
      { x: spot.x, z: spot.z },
    ];
  }

  pathBackToDesk(ch) {
    if (ch.coffeeSpot) ch.coffeeSpot.taken = null;
    ch.coffeeSpot = null;
    const seat = ch.seat;
    const aisleZ = seat.podZ + seat.side * (POD_SPACING_Z / 2);
    const corridorX = this.L.xStart;
    const p = ch.root.position;
    return [
      { x: corridorX, z: p.z < this.coffeeCenter.z ? p.z : this.coffeeCenter.z },
      { x: corridorX, z: aisleZ },
      { x: seat.x, z: aisleZ },
      { x: seat.x, z: seat.z + seat.side * 0.55 },
      { x: seat.x, z: seat.z },
    ];
  }

  coffeeFacing(pos) {
    return Math.atan2(this.coffeeCenter.x - pos.x, this.coffeeCenter.z - pos.z);
  }

  // ------------------------------------------------------------ per-frame + live data
  drawLaptop(ch, t) {
    drawLaptop(ch.laptop.canvas.ctx, { character: ch, repoLabel: `${this.world.owner.login}/${this.repoName}`, language: this.data.repo.language, t });
    ch.laptop.tex.needsUpdate = true;
    ch.laptop.lastDraw = t;
  }

  update(dt, t, camera) {
    this.elevator.update(dt, camera.position, t);
    const cam = camera.position;
    for (const ch of this.characters) {
      ch.update(dt, t);
      const d = Math.hypot(ch.root.position.x - cam.x, ch.root.position.z - cam.z);
      // nearby screens animate (typing), far ones only redraw when something changes
      if (ch.awayChanged || (d < 8 && t - ch.laptop.lastDraw > 0.25)) {
        ch.awayChanged = false;
        this.drawLaptop(ch, t);
      }
      const op = THREE.MathUtils.clamp(1 - (d - 7) / 5, 0, 1);
      ch.tag.material.opacity = op;
      ch.tag.visible = this.showTags && op > 0.01;
    }
    this.updateMarker(dt, t);
  }

  findCharacter(login) {
    const key = login.toLowerCase();
    return this.characters.find((c) => c.login.toLowerCase() === key) || null;
  }

  /** Hide the desk characters of these people (lower-case logins) while they walk around the floor live. */
  setHidden(logins) {
    for (const ch of this.characters) ch.root.visible = !logins.has(ch.login.toLowerCase());
  }

  /**
   * Someone changed how they look: rebuild their desk character, at their desk. Returns true when it was rebuilt
   * (the interaction targets changed with it).
   */
  restyle(login, character, dev = null) {
    const i = this.characters.findIndex((c) => c.login.toLowerCase() === login.toLowerCase());
    if (i < 0) return false;
    const old = this.characters[i];
    if (JSON.stringify(old.character) === JSON.stringify(character || null)) return false;
    const ch = new Character(dev || old.dev, { seat: old.seat, floor: this, character });
    ch.laptop = old.laptop;
    ch.hitbox.userData.interact = old.hitbox.userData.interact;
    ch.root.visible = old.root.visible;
    if (old.coffeeSpot) old.coffeeSpot.taken = null;
    if (this.marker && this.marker.ch === old) this.clearMarker();
    this.group.remove(old.root);
    old.dispose();
    disposeTree(old.root);
    this.group.add(ch.root);
    this.interactables[this.interactables.indexOf(old.hitbox)] = ch.hitbox;
    this.characters[i] = ch;
    ch.awayChanged = true;
    return true;
  }

  /** Where to stand to see someone: behind their shoulder at the desk, or next to them on a break. */
  personSpot(login) {
    const ch = this.findCharacter(login);
    if (!ch) return null;
    const atDesk = ch.state === 'desk';
    const p = ch.root.position;
    const x = atDesk ? ch.seat.x + 0.85 : p.x + 1.8;
    const z = atDesk ? ch.seat.z + ch.seat.side * 2.15 : p.z + 0.6;
    const lookX = atDesk ? ch.seat.x : p.x;
    const lookZ = atDesk ? ch.seat.z - ch.seat.side * 0.5 : p.z;
    return { x, z, yaw: Math.atan2(-(lookX - x), -(lookZ - z)) };
  }

  /** Bouncing arrow over someone's head (used by the phone's "Take me there"). */
  highlight(login, seconds = 12) {
    this.clearMarker();
    const ch = this.findCharacter(login);
    if (!ch) return false;
    const g = new THREE.Group();
    mesh(cone(0.17, 0.36, 16), toon('#ffd43b'), { rx: Math.PI, cast: false, parent: g });
    mesh(torus(0.15, 0.035, 8, 24), toon('#ff922b'), { y: 0.24, rx: Math.PI / 2, cast: false, parent: g });
    ch.root.add(g);
    this.marker = { group: g, ch, until: performance.now() + seconds * 1000 };
    return true;
  }

  updateMarker(dt, t) {
    const m = this.marker;
    if (!m) return;
    if (performance.now() > m.until) return this.clearMarker();
    m.group.position.y = (m.ch.sit > 0.5 ? 2.08 : 2.3) + Math.abs(Math.sin(t * 4)) * 0.16;
    m.group.rotation.y += dt * 2.5;
  }

  clearMarker() {
    if (!this.marker) return;
    this.marker.group.removeFromParent();
    this.marker = null;
  }

  /** Apply fresh data. Returns false when the team changed and the floor should be rebuilt. */
  updateData(data) {
    // Compare as sets: people keep their desks even if the activity ordering changes.
    const current = new Set(this.characters.map((c) => c.login));
    const next = data.devs.slice(0, MAX_SEATED);
    if (next.length !== current.size || next.some((d) => !current.has(d.login))) return false;
    this.data = data;
    const byLogin = new Map(data.devs.map((d) => [d.login, d]));
    for (const ch of [...this.characters]) {
      const dev = byLogin.get(ch.login);
      if (!dev) continue;
      if (this.restyle(ch.login, dev.character, dev)) continue; // a new look: rebuilt, with the fresh data
      ch.setDev(dev);
      ch.awayChanged = true;
    }
    this.drawBoard();
    this.drawSign();
    return true;
  }

  setWorld(world) {
    this.world = world;
    this.drawSign();
  }

  refreshAvatars() {
    for (const ch of this.characters) {
      ch.refreshAvatar();
      ch.awayChanged = true;
    }
    this.drawBoard();
  }

  dispose() {
    for (const ch of this.characters) ch.dispose();
    this.elevator.dispose();
    for (const t of this.disposables) t.dispose();
    disposeTree(this.group);
  }
}
