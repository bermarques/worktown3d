// First-person walker: pointer-lock mouse look, WASD, sprint, simple AABB collision, gentle head bob.
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE = 1.62;
const RADIUS = 0.3;

export class Player {
  constructor(camera, domElement) {
    this.camera = camera;
    this.controls = new PointerLockControls(camera, domElement);
    this.controls.pointerSpeed = 0.8;
    this.sensitivity = 1;
    this.keys = new Set();
    this.colliders = [];
    this.frozen = false;
    this.vel = new THREE.Vector2();
    this.bob = 0;
    this._fwd = new THREE.Vector3();
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.controls.addEventListener('unlock', () => this.keys.clear());
  }

  get locked() {
    return this.controls.isLocked;
  }

  /** True when the player can move: pointer lock, or the drag-to-look fallback. */
  get active() {
    return this.controls.isLocked || this.dragMode;
  }

  /**
   * Fallback for browsers/embeds without Pointer Lock: hold the mouse button and drag to look.
   * A click without dragging is reported through `onClick` so it can interact.
   */
  enableDragMode(onClick) {
    if (this.dragMode) return;
    this.dragMode = true;
    const el = this.controls.domElement;
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    let drag = null;
    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      euler.setFromQuaternion(this.camera.quaternion);
      euler.y -= dx * 0.0045 * this.sensitivity;
      euler.x = THREE.MathUtils.clamp(euler.x - dy * 0.0045 * this.sensitivity, -1.45, 1.45);
      this.camera.quaternion.setFromEuler(euler);
    });
    const end = () => {
      if (!drag) return;
      const click = drag.moved < 6;
      drag = null;
      el.style.cursor = 'grab';
      if (click && onClick) onClick();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => {
      drag = null;
      el.style.cursor = 'grab';
    });
  }

  lock() {
    if (this.dragMode) return;
    try {
      const p = this.controls.domElement.requestPointerLock();
      if (p && p.catch) p.catch(() => document.dispatchEvent(new Event('pointerlockerror')));
    } catch {
      document.dispatchEvent(new Event('pointerlockerror'));
    }
  }

  unlock() {
    if (this.locked) this.controls.unlock();
  }

  setSensitivity(v) {
    this.sensitivity = v;
    this.controls.pointerSpeed = 0.8 * v;
  }

  setPosition(x, z, yaw) {
    this.camera.position.set(x, EYE, z);
    if (yaw !== undefined) this.camera.rotation.set(0, yaw, 0, 'YXZ');
    this.vel.set(0, 0);
  }

  update(dt) {
    const k = this.keys;
    let f = 0;
    let r = 0;
    if (this.active && !this.frozen) {
      if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
    }
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 6.5 : 3.6;
    this.camera.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    this._fwd.normalize();
    const fx = this._fwd.x;
    const fz = this._fwd.z;
    let dx = fx * f - fz * r;
    let dz = fz * f + fx * r;
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      dx = (dx / len) * speed;
      dz = (dz / len) * speed;
    }
    const a = 1 - Math.exp(-12 * dt);
    this.vel.x += (dx - this.vel.x) * a;
    this.vel.y += (dz - this.vel.y) * a;

    const p = this.camera.position;
    p.x += this.vel.x * dt;
    this.resolve('x', this.vel.x);
    p.z += this.vel.y * dt;
    this.resolve('z', this.vel.y);

    const moving = Math.hypot(this.vel.x, this.vel.y);
    this.bob += dt * moving * 2.4;
    p.y = EYE + Math.sin(this.bob) * 0.035 * Math.min(1, moving / 3);
  }

  resolve(axis, v) {
    const p = this.camera.position;
    for (const c of this.colliders) {
      if (c.active === false) continue;
      if (p.x > c.minX - RADIUS && p.x < c.maxX + RADIUS && p.z > c.minZ - RADIUS && p.z < c.maxZ + RADIUS) {
        if (axis === 'x') p.x = v > 0 ? c.minX - RADIUS : v < 0 ? c.maxX + RADIUS : p.x;
        else p.z = v > 0 ? c.minZ - RADIUS : v < 0 ? c.maxZ + RADIUS : p.z;
      }
    }
  }
}

/** Center-screen raycast against interactable objects; walls in the list block the ray. */
export class Interactor {
  constructor(camera) {
    this.camera = camera;
    this.ray = new THREE.Raycaster();
    this.ray.far = 4.2;
    this.targets = [];
    this.center = new THREE.Vector2(0, 0);
  }

  setTargets(list) {
    this.targets = list;
  }

  update() {
    this.ray.setFromCamera(this.center, this.camera);
    // Rays hit hidden objects too: skip anything inside a hidden group (a desk character whose person is here live).
    const hit = this.ray.intersectObjects(this.targets, false).find((h) => shown(h.object));
    return (hit && hit.object.userData.interact) || null;
  }
}

function shown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}
