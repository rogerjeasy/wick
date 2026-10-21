/* Wick: the project pages' one script (an ES module, loaded by every page in docs/).

   1. Reveal on scroll: each [data-reveal] block rises 12 px and fades in, in
      200 ms, with Motion (./vendor/motion.js, from `npm run pages:vendor`).
      Children marked [data-reveal-item] follow one another by 30 ms. Under
      prefers-reduced-motion nothing moves: the page's inline head script never
      sets .motion-ok, so nothing was hidden, and this does nothing.
   2. The film on the project page: a silent loop while it is on screen, and
      the narrated cut from the start on request. */
import { animate, inView, stagger } from './vendor/motion.js';

const root = document.documentElement;
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = [0.2, 0, 0, 1];

function reveal() {
  if (still || !root.classList.contains('motion-ok')) return;
  window.__wickReveal = true;
  inView(
    '[data-reveal]',
    (el) => {
      const items = el.querySelectorAll('[data-reveal-item]');
      animate(el, { opacity: [0, 1], y: [12, 0] }, { duration: 0.2, ease: EASE });
      if (items.length) animate(items, { opacity: [0, 1], y: [12, 0] }, { duration: 0.2, ease: EASE, delay: stagger(0.03, { startDelay: 0.05 }) });
    },
    { margin: '0px 0px -8% 0px' },
  );
}

function film() {
  const box = document.getElementById('film');
  const v = document.getElementById('film-video');
  if (!box || !v) return;
  const sound = document.getElementById('film-sound');
  const soundLabel = document.getElementById('film-sound-label');
  const dur = sound.querySelector('.dur');
  const pause = document.getElementById('film-pause');
  const cc = document.getElementById('film-cc');
  const full = document.getElementById('film-full');
  const start = document.getElementById('film-start');
  const bar = document.getElementById('film-progress');
  const track = v.textTracks && v.textTracks[0];
  let heard = false;
  let userPaused = still;
  let inSight = true;
  if (track) track.mode = 'hidden';

  const clock = (t) => {
    const s = Math.max(0, Math.round(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const showPaused = (p) => {
    pause.setAttribute('aria-pressed', p ? 'true' : 'false');
    pause.setAttribute('aria-label', p ? 'Play the film' : 'Pause the film');
    box.classList.toggle('still', p && !heard);
  };
  const play = () => {
    const r = v.play();
    if (r && r.catch) r.catch(() => showPaused(true));
  };
  const withSound = () => {
    if (!heard) {
      heard = true;
      v.currentTime = 0;
      v.loop = false;
    }
    v.muted = false;
    userPaused = false;
    sound.setAttribute('aria-pressed', 'true');
    soundLabel.textContent = 'Sound on';
    box.classList.remove('still');
    play();
  };
  const silent = () => {
    v.muted = true;
    sound.setAttribute('aria-pressed', 'false');
    soundLabel.textContent = heard ? 'Sound off' : 'Watch with sound';
  };

  sound.addEventListener('click', () => (v.muted || v.paused ? withSound() : silent()));
  start.addEventListener('click', withSound);
  // "Watch the film" at the top of the page: bring the film into view and play it with sound.
  document.querySelectorAll('[data-play-film]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      box.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      withSound();
      sound.focus({ preventScroll: true });
    }),
  );
  pause.addEventListener('click', () => {
    if (v.paused) {
      userPaused = false;
      play();
    } else {
      userPaused = true;
      v.pause();
    }
  });
  cc.addEventListener('click', () => {
    const on = cc.getAttribute('aria-pressed') !== 'true';
    cc.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (track) track.mode = on ? 'showing' : 'hidden';
  });
  full.addEventListener('click', () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (box.requestFullscreen) box.requestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  });
  v.addEventListener('play', () => showPaused(false));
  v.addEventListener('pause', () => showPaused(true));
  v.addEventListener('ended', () => {
    // The narrated cut is over: back to the quiet loop, ready to be heard again.
    heard = false;
    v.loop = true;
    silent();
    soundLabel.textContent = 'Watch again with sound';
    v.currentTime = 0;
    if (!still && inSight) play();
  });
  v.addEventListener('timeupdate', () => {
    dur.textContent = heard && v.duration ? clock(v.duration - v.currentTime) : '3:04';
    if (v.duration) bar.style.transform = `scaleX(${v.currentTime / v.duration})`;
  });

  if (still) {
    v.preload = 'metadata';
    showPaused(true);
    return;
  }
  new IntersectionObserver(
    (entries) => {
      inSight = entries[0].isIntersecting;
      if (inSight && !userPaused) play();
      else if (!inSight && v.muted && !v.paused) v.pause(); // a film being listened to keeps playing
    },
    { threshold: 0.2 },
  ).observe(box);
}

function autoplayClips() {
  document.querySelectorAll('video.autoplay').forEach((v) => {
    if (still) {
      v.controls = true;
      v.preload = 'metadata';
      return;
    }
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const p = v.play();
            if (p && p.catch) p.catch(() => (v.controls = true));
          } else v.pause();
        }
      },
      { threshold: 0.25 },
    ).observe(v);
  });
}

reveal();
film();
autoplayClips();
