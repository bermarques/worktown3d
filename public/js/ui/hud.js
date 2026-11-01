// Heads-up display: floor label, crosshair + interaction hint, toasts, fades and the loading veil.
import { h } from './dom.js';

const $ = (id) => document.getElementById(id);

export const hud = {
  setFloor(label, title) {
    $('floor-badge').textContent = label;
    $('floor-title').textContent = title;
  },

  setHint(text) {
    const el = $('hint');
    if (!text) {
      el.classList.remove('show');
      $('crosshair').classList.remove('active');
      return;
    }
    el.replaceChildren(h('kbd', null, 'E'), ' ', text);
    el.classList.add('show');
    $('crosshair').classList.add('active');
  },

  showHud(on) {
    $('hud').classList.toggle('hidden', !on);
  },

  toast(message, kind = 'info', ms = 4200) {
    const el = h('div', { class: `toast toast-${kind}` }, message);
    $('toasts').append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, ms);
  },

  fade(to, ms = 350) {
    const el = $('fade');
    el.style.transitionDuration = `${ms}ms`;
    el.style.opacity = String(to);
    el.style.pointerEvents = to > 0 ? 'auto' : 'none';
    return new Promise((r) => setTimeout(r, ms));
  },

  loading(text) {
    const el = $('loading');
    if (!text) {
      el.classList.remove('show');
      return;
    }
    el.querySelector('span').textContent = text;
    el.classList.add('show');
  },

  pause(on) {
    $('pause').classList.toggle('show', on);
  },

  setPhoneBadge(n) {
    const b = $('phone-chip').querySelector('.badge');
    b.textContent = n > 99 ? '99+' : String(n || '');
    b.classList.toggle('show', n > 0);
  },

  /** How many other people are in the building right now (multiplayer); hidden when it's just you. */
  setOnline(n) {
    const el = $('online-chip');
    el.textContent = `🟢 ${n} ${n === 1 ? 'other person' : 'others'} here`;
    el.classList.toggle('hidden', !n);
  },

  /** Camera flash. */
  flash() {
    const el = $('flash');
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
  },
};

// ---------------------------------------------------------------- synthesized sounds
let audio = null;
let soundOn = true;
export function setSoundEnabled(on) {
  soundOn = on;
}

function ctx() {
  if (!soundOn) return null;
  audio = audio || new AudioContext();
  return audio;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.12 } = {}) {
  const a = ctx();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.05);
}

/** Short UI blip (phone in/out). */
export function blip(freq = 880) {
  try {
    tone(freq, 0, 0.12, { type: 'triangle', gain: 0.08 });
  } catch {
    /* audio is optional */
  }
}

/** Camera shutter: a quick noise-like double click. */
export function shutter() {
  hud.flash();
  try {
    tone(2400, 0, 0.05, { type: 'square', gain: 0.05 });
    tone(1600, 0.07, 0.06, { type: 'square', gain: 0.05 });
  } catch {
    /* audio is optional */
  }
}

/** Little synthesized elevator "ding". */
export function ding() {
  try {
    if (!ctx()) return;
    const now = audio.currentTime;
    [[1318.5, 0], [1046.5, 0.22]].forEach(([freq, delay]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, now + delay);
      g.gain.linearRampToValueAtTime(0.18, now + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.1);
      o.connect(g).connect(audio.destination);
      o.start(now + delay);
      o.stop(now + delay + 1.2);
    });
  } catch {
    /* audio is optional */
  }
}
