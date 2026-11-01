// Multiplayer: the people who are in the building right now, drawn on the floor you're on. They move smoothly
// between position updates, and while someone is on a floor their desk character there is hidden, so each person
// appears only once.
import * as THREE from 'three';
import { disposeTree } from '../engine/toon.js';
import { Character } from './character.js';

/** Farther apart than this between updates (they took the elevator, or we missed some): appear there at once. */
const SNAP_DISTANCE = 4;
/** How fast a character catches up with the latest position (per second). */
const FOLLOW = 10;
/** Moving faster than this (m/s) looks like walking. */
const WALKING = 0.25;

/** Characters face +z, while a camera with yaw 0 looks down -z. */
const facing = (yaw) => yaw + Math.PI;

/** A connected player: their position comes from the network instead of desk life and coffee breaks. */
class RemoteCharacter extends Character {
  constructor(player) {
    const { x, z, yaw } = player.at;
    super({ login: player.login, name: player.name, status: 'idle', current: null }, { seat: { x, z, rotY: facing(yaw) }, floor: null, character: player.character });
    this.player = player;
    this.state = 'remote';
    this.sit = 0;
    this.speed = 0;
    this.target = { x, z, rotY: facing(yaw) };
  }

  statusLine() {
    return '🟢 here now';
  }

  moveTo({ x, z, yaw }) {
    this.target = { x, z, rotY: facing(yaw) };
    const p = this.root.position;
    if (Math.hypot(x - p.x, z - p.z) > SNAP_DISTANCE) p.set(x, 0, z);
  }

  update(dt, t) {
    const p = this.root.position;
    const k = 1 - Math.exp(-FOLLOW * dt);
    const dx = (this.target.x - p.x) * k;
    const dz = (this.target.z - p.z) * k;
    p.x += dx;
    p.z += dz;
    this.speed = THREE.MathUtils.damp(this.speed, Math.hypot(dx, dz) / Math.max(dt, 1e-3), 8, dt);
    const turn = Math.atan2(Math.sin(this.target.rotY - this.root.rotation.y), Math.cos(this.target.rotY - this.root.rotation.y));
    this.root.rotation.y += turn * (1 - Math.exp(-10 * dt));
    this.animate(dt, t, this.speed > WALKING, 0);
  }
}

export class RemotePlayers {
  /** @param {{ onChange: () => void }} hooks  onChange: the set of characters changed (for interaction targets) */
  constructor({ onChange }) {
    this.onChange = onChange;
    this.group = new THREE.Group();
    this.characters = new Map(); // GitHub user id -> RemoteCharacter
    this.players = new Map(); // GitHub user id -> player, everyone in the building
    this.floor = null;
    this.floorKey = undefined;
    /** Your own login while you're live: your desk character hides on the floor you're on, too. */
    this.selfLogin = null;
  }

  /** The floor you're on now (repo name, or null for the lobby). */
  setFloor(floor, floorKey) {
    this.floor = floor;
    this.floorKey = floorKey;
    for (const id of [...this.characters.keys()]) this.drop(id);
    for (const player of this.players.values()) this.place(player);
    this.afterChange();
  }

  /** Everyone in the building (after connecting), or nobody (offline). */
  reset(players, selfLogin = null) {
    this.selfLogin = selfLogin;
    this.players = new Map(players.map((p) => [p.id, p]));
    for (const id of [...this.characters.keys()]) this.drop(id);
    for (const player of this.players.values()) this.place(player);
    this.afterChange();
  }

  /** Someone arrived, moved or left. */
  upsert(player) {
    this.players.set(player.id, player);
    const changed = this.place(player);
    if (changed) this.afterChange();
  }

  remove(player) {
    this.players.delete(player.id);
    if (this.characters.has(player.id)) {
      this.drop(player.id);
      this.afterChange();
    }
  }

  /** Someone changed how they look: rebuild their character where it stands. */
  restyle(player) {
    this.players.set(player.id, player);
    const old = this.characters.get(player.id);
    if (!old) return;
    const { x, z } = old.root.position;
    const rotY = old.root.rotation.y;
    this.drop(player.id);
    const ch = this.create(player);
    ch.root.position.set(x, 0, z);
    ch.root.rotation.y = rotY;
    this.afterChange();
  }

  /** Interaction targets, next to the floor's own. */
  hitboxes() {
    return [...this.characters.values()].map((ch) => ch.hitbox);
  }

  update(dt, t, camera, showTags) {
    const cam = camera.position;
    for (const ch of this.characters.values()) {
      ch.update(dt, t);
      const d = Math.hypot(ch.root.position.x - cam.x, ch.root.position.z - cam.z);
      const opacity = THREE.MathUtils.clamp(1 - (d - 7) / 5, 0, 1);
      ch.tag.material.opacity = opacity;
      ch.tag.visible = showTags && opacity > 0.01;
    }
  }

  refreshAvatars() {
    for (const ch of this.characters.values()) ch.refreshAvatar();
  }

  /** Show, move or remove someone's character on this floor. Returns true when one was added or removed. */
  place(player) {
    const here = this.floor && player.at && player.at.floor === this.floorKey;
    const ch = this.characters.get(player.id);
    if (here && ch) {
      ch.moveTo(player.at);
      return false;
    }
    if (here) {
      this.create(player);
      return true;
    }
    if (ch) {
      this.drop(player.id);
      return true;
    }
    return false;
  }

  create(player) {
    const ch = new RemoteCharacter(player);
    const desk = this.floor && this.floor.findCharacter ? this.floor.findCharacter(player.login) : null;
    // People with a desk here open the same panel as their desk character; anyone else, their card on the phone.
    ch.hitbox.userData.interact = desk ? { label: `Talk to @${player.login}`, kind: 'dev', login: player.login } : { label: `@${player.login} is here`, kind: 'player', login: player.login };
    this.characters.set(player.id, ch);
    this.group.add(ch.root);
    return ch;
  }

  drop(id) {
    const ch = this.characters.get(id);
    if (!ch) return;
    this.characters.delete(id);
    this.group.remove(ch.root);
    ch.dispose();
    disposeTree(ch.root);
  }

  afterChange() {
    if (this.floor && this.floor.setHidden) {
      const hidden = new Set([...this.characters.values()].map((ch) => ch.login.toLowerCase()));
      if (this.selfLogin) hidden.add(this.selfLogin.toLowerCase());
      this.floor.setHidden(hidden);
    }
    this.onChange();
  }
}
