import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/**
 * The throughput core in WebGL. Every lane is one open connection the
 * engines report; streaks flow along it at a pace set by that connection's
 * measured speed and funnel into the core, which spins and glows with the
 * total rate. Nothing here is invented: with no download there are a few
 * ambient lanes drifting slowly, and a finished download sends one
 * shockwave out of the core.
 *
 * Owned imperatively (no React in here) so the 60 fps loop never re-renders
 * a component. `dispose()` frees every GPU object by hand: the garbage
 * collector does not reach into the graphics driver.
 */

const STREAM_START = -15;
const CORE_X = 6.5;
const SPREAD_Y = 3.4;
const SPREAD_Z = 2.6;
const MAX_LANES = 48;
const AMBIENT_LANES = 14;
const LANE_SEGMENTS = 28;
const PARTICLES = { desktop: 2400, phone: 700 };
const BYTES_PER_STREAK = 256 * 1024;
const IDLE_FRAME_MS = 33;
const PULSE_SECONDS = 0.9;

/** Seconds a streak takes to reach the core at `bps` on its lane. */
function crossingSeconds(bps) {
  if (!bps) return 14;
  const t = 4.4 - Math.log10(Math.max(bps, 1024)) * 0.5;
  return Math.min(7, Math.max(0.5, t));
}

/** A soft round dot, drawn once, used for streaks and the halo. */
function glowTexture() {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Deterministic depth per lane, so lanes do not reshuffle on every update. */
const laneDepth = (i) => {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * SPREAD_Z;
};

const ease = (t) => t ** 1.7;

function lanePoint(lane, t, out, offset) {
  const k = 1 - ease(t);
  out[offset] = STREAM_START + (CORE_X - STREAM_START) * t;
  out[offset + 1] = lane.y * k;
  out[offset + 2] = lane.z * k;
}

export function createCoreScene(canvas, { phone, reduced }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !phone,
    alpha: false,
    powerPreference: phone ? "low-power" : "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, phone ? 1.5 : 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 100);
  camera.position.set(0, 0, 15.5);
  const world = new THREE.Group();
  scene.add(world);

  const glow = glowTexture();
  const accent = new THREE.Color("#ff9f1c");

  // Lanes: one line per connection, funnelling into the core.
  const laneMaterial = new THREE.LineBasicMaterial({ color: "#40464b", transparent: true, opacity: 0.25 });
  let laneLines = null;
  let lanes = [];

  const buildLanes = (count) => {
    lanes = Array.from({ length: count }, (_, i) => ({
      y: count === 1 ? 0 : -SPREAD_Y + (2 * SPREAD_Y * i) / (count - 1),
      z: laneDepth(i),
      bps: 0,
    }));
    if (laneLines) {
      world.remove(laneLines);
      laneLines.geometry.dispose();
    }
    const pts = new Float32Array(count * LANE_SEGMENTS * 2 * 3);
    let o = 0;
    for (const lane of lanes) {
      for (let s = 0; s < LANE_SEGMENTS; s += 1) {
        lanePoint(lane, s / LANE_SEGMENTS, pts, o);
        lanePoint(lane, (s + 1) / LANE_SEGMENTS, pts, o + 3);
        o += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    laneLines = new THREE.LineSegments(geo, laneMaterial);
    world.add(laneLines);
  };

  // Streaks.
  const maxParticles = phone ? PARTICLES.phone : PARTICLES.desktop;
  const positions = new Float32Array(maxParticles * 3);
  const pLane = new Uint16Array(maxParticles);
  const pT = new Float32Array(maxParticles);
  const pRate = new Float32Array(maxParticles);
  for (let i = 0; i < maxParticles; i += 1) {
    // Spread over every lane from the first frame, not only after a lap.
    pLane[i] = Math.floor(Math.random() * MAX_LANES);
    pT[i] = Math.random();
    pRate[i] = 0.7 + Math.random() * 0.6;
  }
  const pointsGeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  pointsGeo.setAttribute("position", posAttr);
  const pointsMat = new THREE.PointsMaterial({
    size: phone ? 0.2 : 0.16,
    map: glow,
    color: accent,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(pointsGeo, pointsMat);
  world.add(points);
  let particleCount = 0;

  // The core.
  const core = new THREE.Group();
  core.position.set(CORE_X, 0, 0);
  world.add(core);
  const ringMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95 });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.035, 8, 128), ringMat);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.025, 8, 96), ringMat);
  ringB.rotation.x = Math.PI / 2.6;
  const icoMat = new THREE.MeshBasicMaterial({ color: accent, wireframe: true, transparent: true, opacity: 0.6 });
  const ico = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), icoMat);
  const haloMat = new THREE.SpriteMaterial({
    map: glow,
    color: accent,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(4);
  const shockMat = new THREE.MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const shock = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 96), shockMat);
  core.add(halo, ringA, ringB, ico, shock);

  // Bloom on the desktop dark theme; phones and the light theme skip it.
  let composer = null;
  let bloomPass = null;
  if (!phone) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.12);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }
  let bloomOn = Boolean(composer);

  const state = { laneSpeeds: [], speed: 0, armed: false };
  let intensity = 0.15;
  let pulse = -1;
  let time = 0;
  const pointer = { x: 0, y: 0 };
  const onPointer = (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });

  const live = () => state.laneSpeeds.length > 0;

  const targetParticles = () => {
    if (live()) {
      const wanted = state.laneSpeeds.reduce((s, bps) => s + Math.ceil(bps / BYTES_PER_STREAK), 0);
      return Math.min(maxParticles, 120 + wanted);
    }
    if (state.armed) return Math.min(maxParticles, 320);
    return phone ? 50 : 140;
  };

  const step = (dt) => {
    time += dt;
    const targetIntensity = live()
      ? 0.45 + Math.min(1, Math.log10(1 + state.speed / (256 * 1024)) / 2.4) * 0.55
      : state.armed ? 0.5 : 0.16;
    intensity += (targetIntensity - intensity) * Math.min(1, dt * 3);

    particleCount = targetParticles();
    pointsGeo.setDrawRange(0, particleCount);
    const count = lanes.length;
    for (let i = 0; i < particleCount; i += 1) {
      const lane = lanes[pLane[i] % count];
      const bps = lane.bps;
      const crossing = live() ? crossingSeconds(bps) : state.armed ? 5 : 14;
      pT[i] += (dt / crossing) * pRate[i];
      if (pT[i] >= 1) {
        pT[i] -= 1;
        pLane[i] = Math.floor(Math.random() * MAX_LANES);
      }
      lanePoint(lanes[pLane[i] % count], pT[i], positions, i * 3);
    }
    posAttr.needsUpdate = true;

    ringA.rotation.z += dt * (0.25 + intensity * 2.4);
    ringB.rotation.y += dt * (0.35 + intensity * 1.6);
    ico.rotation.y += dt * (0.2 + intensity);
    ico.rotation.x += dt * 0.15;
    const breathe = Math.sin(time * 2.1) * 0.12 * intensity;
    halo.scale.setScalar(2.2 + intensity * 2.2 + breathe);
    haloMat.opacity = 0.08 + intensity * 0.32;
    laneMaterial.opacity = 0.1 + intensity * 0.3;
    pointsMat.opacity = 0.55 + intensity * 0.45;
    if (bloomPass) bloomPass.strength = 0.5 + intensity * 0.9;

    if (pulse >= 0) {
      pulse += dt / PULSE_SECONDS;
      shock.scale.setScalar(1 + pulse * 5.5);
      shockMat.opacity = Math.max(0, (1 - pulse) * 0.9);
      if (pulse >= 1) {
        pulse = -1;
        shockMat.opacity = 0;
      }
    }

    world.rotation.y += (pointer.x * 0.16 + Math.sin(time * 0.25) * 0.03 - world.rotation.y) * Math.min(1, dt * 2);
    world.rotation.x += (pointer.y * 0.1 - world.rotation.x) * Math.min(1, dt * 2);
  };

  const render = () => {
    if (bloomOn && composer) composer.render();
    else renderer.render(scene, camera);
  };

  let raf = 0;
  let last = 0;
  let lastFrame = 0;
  let visible = true;

  const busy = () => live() || state.armed || pulse >= 0;
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    // Idle runs at half rate: the scene still breathes, the battery barely notices.
    if (!busy() && now - lastFrame < IDLE_FRAME_MS) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    lastFrame = now;
    step(dt);
    render();
  };

  const start = () => {
    if (reduced) {
      render();
      return;
    }
    if (!raf && visible && !document.hidden) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };

  buildLanes(AMBIENT_LANES);
  // Spread the streaks out once so a still frame (reduced motion) has them.
  step(0);

  return {
    resize(width, height) {
      if (!width || !height) return;
      const aspect = width / height;
      renderer.setSize(width, height, false);
      composer?.setSize(width, height);
      camera.aspect = aspect;
      // Narrow strips (phones) pull back and slide left so the core stays in view.
      camera.position.z = 15.5 * Math.min(2.3, Math.max(1, 2.6 / aspect));
      world.position.x = aspect < 2 ? -2.5 : 0;
      camera.updateProjectionMatrix();
      if (reduced || !raf) render();
    },
    setColors({ accent: a, lane, background, light }) {
      const c = new THREE.Color(a);
      for (const m of [pointsMat, ringMat, icoMat, haloMat, shockMat]) m.color.copy(c);
      laneMaterial.color.set(lane);
      bloomOn = Boolean(composer) && !light;
      // The bloom chain encodes the clear colour to sRGB once more than the
      // plain renderer does (measured: #0b1015 came out #3d4852), so the
      // colour is decoded one extra time on that path.
      const clear = new THREE.Color(background);
      if (bloomOn) clear.convertSRGBToLinear();
      renderer.setClearColor(clear, 1);
      const blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      pointsMat.blending = blending;
      haloMat.blending = blending;
      pointsMat.needsUpdate = true;
      haloMat.needsUpdate = true;
      if (reduced || !raf) render();
    },
    setData({ lanes: jobLanes, speed, armed }) {
      const speeds = [];
      for (const job of jobLanes) {
        const n = Math.max(1, job.connections || 1);
        for (let i = 0; i < n && speeds.length < MAX_LANES; i += 1) speeds.push((job.speed || 0) / n);
      }
      state.laneSpeeds = speeds;
      state.speed = speed;
      state.armed = armed;
      const want = speeds.length || AMBIENT_LANES;
      if (want !== lanes.length) buildLanes(want);
      lanes.forEach((lane, i) => {
        lane.bps = speeds[i] || 0;
      });
      if (reduced) {
        step(0);
        render();
      } else {
        start();
      }
    },
    pulse() {
      pulse = 0;
      if (reduced) return;
      start();
    },
    setVisible(v) {
      visible = v && !document.hidden;
      if (visible) start();
      else stop();
    },
    dispose() {
      stop();
      window.removeEventListener("pointermove", onPointer);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      laneMaterial.dispose();
      glow.dispose();
      composer?.dispose();
      renderer.dispose();
    },
  };
}
