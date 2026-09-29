// Procedural WebGL signing avatar. It has two articulated arms and five
// independently bent fingers per hand, so gesture records control joints—not
// a flat illustration. The main app falls back to Canvas if this module fails.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';

const skin = 0xf0c7a4;
const cyan = 0x22d3ee;
const calm = (x, y, shape, z = 0) => ({ x, y, shape, z });
const REST = { right: calm(0.92, 0.05, 'relaxed'), left: calm(-0.92, 0.05, 'relaxed'), mood: 'neutral', motion: 'none' };

const POSES = {
  idle: REST,
  wave: { right: calm(1.04, 1.54, 'open', 0.25), left: REST.left, mood: 'happy', motion: 'wave' },
  goodbye: { right: calm(1.04, 1.54, 'open', 0.25), left: REST.left, mood: 'happy', motion: 'wave' },
  stop: { right: calm(0.82, 1.1, 'open', 0.32), left: REST.left, mood: 'alert', motion: 'none' },
  yes: { right: calm(0.5, 0.72, 'fist'), left: REST.left, mood: 'neutral', motion: 'nod' },
  no: { right: calm(0.3, 1.0, 'point'), left: calm(-0.3, 1.0, 'point'), mood: 'neutral', motion: 'side' },
  good: { right: calm(0.55, 0.64, 'thumb'), left: REST.left, mood: 'happy', motion: 'none' },
  bad: { right: calm(0.55, 0.38, 'thumb'), left: REST.left, mood: 'sad', motion: 'none' },
  thank_you: { right: calm(0.22, 1.08, 'flat', 0.1), left: REST.left, mood: 'happy', motion: 'out' },
  please: { right: calm(0.42, 0.28, 'flat'), left: calm(-0.42, 0.28, 'flat'), mood: 'neutral', motion: 'circle' },
  me: { right: calm(0.18, 0.65, 'point'), left: REST.left, mood: 'neutral', motion: 'none' },
  you: { right: calm(1.24, 0.82, 'point'), left: REST.left, mood: 'neutral', motion: 'out' },
  want: { right: calm(0.5, 0.72, 'open'), left: calm(-0.5, 0.72, 'open'), mood: 'neutral', motion: 'pull' },
  need: { right: calm(0.4, 1.06, 'hook'), left: REST.left, mood: 'neutral', motion: 'down' },
  help: { right: calm(0, 0.78, 'fist'), left: calm(0, 0.28, 'open'), mood: 'neutral', motion: 'lift' },
  water: { right: calm(0.05, 1.16, 'point'), left: REST.left, mood: 'neutral', motion: 'none' },
  drink: { right: calm(0.08, 1.15, 'cup'), left: REST.left, mood: 'neutral', motion: 'tilt' },
  eat: { right: calm(0.08, 1.12, 'pinch'), left: REST.left, mood: 'neutral', motion: 'tap' },
  phone: { right: calm(0.95, 1.18, 'phone', 0.28), left: REST.left, mood: 'neutral', motion: 'phone' },
  where: { right: calm(1.16, 0.9, 'point'), left: calm(-1.16, 0.9, 'point'), mood: 'neutral', motion: 'side' },
  what: { right: calm(0.62, 0.76, 'open'), left: calm(-0.62, 0.76, 'open'), mood: 'neutral', motion: 'shake' },
  how: { right: calm(0.4, 0.68, 'hook'), left: calm(-0.4, 0.68, 'hook'), mood: 'neutral', motion: 'turn' },
  doctor: { right: calm(0.03, 1.1, 'point'), left: REST.left, mood: 'neutral', motion: 'none' },
  hospital: { right: calm(0.46, 0.84, 'cross'), left: calm(-0.38, 0.5, 'flat'), mood: 'alert', motion: 'none' },
  pain: { right: calm(0.34, 0.44, 'claw'), left: calm(-0.34, 0.44, 'claw'), mood: 'sad', motion: 'twist' },
  emergency: { right: calm(1, 1.46, 'open'), left: calm(-1, 1.46, 'open'), mood: 'alert', motion: 'shake' },
  love: { right: calm(0.22, 0.68, 'heart'), left: calm(-0.22, 0.68, 'heart'), mood: 'happy', motion: 'heart' },
  peace: { right: calm(0.76, 1.04, 'v'), left: REST.left, mood: 'happy', motion: 'none' },
  happy: { right: calm(0.42, 1.38, 'open'), left: calm(-0.42, 1.38, 'open'), mood: 'happy', motion: 'rise' },
  sad: { right: calm(0.38, 0.48, 'flat'), left: calm(-0.38, 0.48, 'flat'), mood: 'sad', motion: 'down' }
};

const ALIASES = {
  thumbs_up: 'good', thumbs_down: 'bad', open_palm: 'stop', fist: 'no', point_up: 'yes', bow: 'thank_you', 'I-LOVE-YOU': 'love',
  friend: 'love', family: 'love', mother: 'love', father: 'love', name: 'what', understand: 'what', again: 'what', slow: 'what',
  food: 'eat', home: 'what', school: 'what', work: 'what', money: 'what', who: 'where', when: 'where', why: 'what',
  today: 'what', tomorrow: 'where', morning: 'happy', night: 'sad', left: 'where', right: 'where', bathroom: 'what', sorry: 'sad', wait: 'stop'
};
const LETTER_SHAPES = { A:'fist', B:'flat', C:'cup', D:'point', E:'fist', F:'pinch', G:'point', H:'point', I:'hook', J:'hook', K:'v', L:'l', M:'fist', N:'fist', O:'cup', P:'v', Q:'point', R:'hook', S:'fist', T:'t', U:'v', V:'v', W:'open', X:'hook', Y:'phone', Z:'point' };

const makeMaterial = color => new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.08 });
const bone = (length, radius, material) => {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 5, 10), material);
  mesh.position.y = -length / 2; mesh.castShadow = true; return mesh;
};

function createFinger(offset, isThumb, material) {
  const root = new THREE.Group();
  root.position.set(offset, isThumb ? 0.03 : 0.12, 0.06);
  if (isThumb) root.rotation.z = offset < 0 ? -0.85 : 0.85;
  const lengths = isThumb ? [0.17, 0.13] : [0.2, 0.14, 0.1];
  const joints = []; let parent = root;
  lengths.forEach(length => {
    const joint = new THREE.Group(); parent.add(joint);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, Math.max(0.01, length - 0.08), 4, 8), material);
    mesh.position.y = length / 2; mesh.castShadow = true; joint.add(mesh);
    const next = new THREE.Group(); next.position.y = length; joint.add(next);
    joints.push(joint); parent = next;
  });
  return { root, joints };
}

function createHand(side) {
  const group = new THREE.Group(); const material = makeMaterial(skin);
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.14, 3, 3, 2), material);
  palm.position.y = 0.22; palm.castShadow = true; group.add(palm);
  const fingers = [-0.15, -0.05, 0.055, 0.15].map(offset => {
    const finger = createFinger(offset, false, material); group.add(finger.root); return finger;
  });
  const thumb = createFinger(side * 0.24, true, material); group.add(thumb.root);
  return { group, fingers, thumb };
}

function createArm(side) {
  const root = new THREE.Group(); root.position.set(side * 0.77, 1.05, 0);
  const upperLength = 0.76, lowerLength = 0.68, material = makeMaterial(skin);
  root.add(bone(upperLength, 0.115, material));
  const elbow = new THREE.Group(); elbow.position.y = -upperLength; root.add(elbow);
  elbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), material)); elbow.add(bone(lowerLength, 0.095, material));
  const wrist = new THREE.Group(); wrist.position.y = -lowerLength; elbow.add(wrist);
  const handModel = createHand(side); handModel.group.position.y = -0.1; handModel.group.rotation.z = Math.PI; wrist.add(handModel.group);
  return { side, root, elbow, wrist, hand: handModel, upperLength, lowerLength };
}

function handBend(shape, index) {
  const bent = [-1.1, -1.1, -0.8], straight = [0, 0, 0];
  if (shape === 'fist') return bent;
  if (shape === 'point' || shape === 'l') return index === 1 ? straight : bent;
  if (shape === 'v') return index === 1 || index === 2 ? straight : bent;
  if (shape === 'pinch' || shape === 'cup') return [-0.55, -0.5, -0.35];
  if (shape === 'hook' || shape === 'claw') return [-0.72, -0.64, -0.48];
  if (shape === 'phone') return index === 1 || index > 2 ? straight : bent;
  if (shape === 't' || shape === 'cross') return index === 1 ? straight : [-0.7, -0.7, -0.4];
  if (shape === 'relaxed') return [-0.24, -0.28, -0.2];
  return straight;
}

function poseHand(handModel, shape) {
  handModel.fingers.forEach((finger, fingerIndex) => finger.joints.forEach((joint, index) => { joint.userData.bend = handBend(shape, fingerIndex + 1)[index] || 0; }));
  const thumb = ['open', 'flat', 'v', 'l', 'phone'].includes(shape) ? [-0.12, -0.08] : [-0.76, -0.55];
  handModel.thumb.joints.forEach((joint, index) => { joint.userData.bend = thumb[index] || 0; });
}

function movement(motion, phase, side) {
  const angle = phase * Math.PI * 2;
  if (motion === 'wave') return { x: Math.sin(angle * 2.4) * 0.21, y: Math.cos(angle * 2.4) * 0.05 };
  if (motion === 'side') return { x: Math.sin(angle * 2) * 0.14, y: 0 };
  if (motion === 'out') return { x: side * Math.sin(angle) * 0.1, y: Math.abs(Math.sin(angle)) * 0.05 };
  if (motion === 'rise') return { x: 0, y: Math.abs(Math.sin(angle)) * 0.13 };
  if (motion === 'down') return { x: 0, y: -Math.abs(Math.sin(angle)) * 0.1 };
  if (motion === 'circle') return { x: Math.cos(angle) * 0.08, y: Math.sin(angle) * 0.08 };
  if (motion === 'shake') return { x: Math.sin(angle * 5) * 0.06, y: 0 };
  if (motion === 'pull') return { x: -side * Math.abs(Math.sin(angle)) * 0.1, y: 0 };
  if (motion === 'lift') return { x: 0, y: Math.abs(Math.sin(angle)) * 0.12 };
  return { x: 0, y: 0 };
}

function poseArm(arm, target, phase, motion) {
  const drift = movement(motion, phase, arm.side);
  const tx = target.x + drift.x, ty = target.y + drift.y, sx = arm.side * 0.77, sy = 1.05;
  const distance = THREE.MathUtils.clamp(Math.hypot(tx - sx, ty - sy), 0.22, arm.upperLength + arm.lowerLength - 0.04);
  const base = Math.atan2(ty - sy, tx - sx);
  const bend = Math.acos(THREE.MathUtils.clamp((arm.upperLength ** 2 + distance ** 2 - arm.lowerLength ** 2) / (2 * arm.upperLength * distance), -1, 1));
  const elbowDirection = base + arm.side * bend;
  const ex = sx + Math.cos(elbowDirection) * arm.upperLength, ey = sy + Math.sin(elbowDirection) * arm.upperLength;
  const forearmDirection = Math.atan2(ty - ey, tx - ex), upperRotation = elbowDirection + Math.PI / 2;
  arm.root.rotation.z = THREE.MathUtils.lerp(arm.root.rotation.z, upperRotation, 0.27);
  arm.elbow.rotation.z = THREE.MathUtils.lerp(arm.elbow.rotation.z, forearmDirection + Math.PI / 2 - upperRotation, 0.27);
  arm.wrist.rotation.z = THREE.MathUtils.lerp(arm.wrist.rotation.z, -arm.elbow.rotation.z * 0.35, 0.16);
  arm.hand.group.rotation.y = THREE.MathUtils.lerp(arm.hand.group.rotation.y, target.z, 0.18);
  poseHand(arm.hand, target.shape);
}

class WebGLAvatar {
  constructor(canvas) {
    if (!window.WebGLRenderingContext) throw new Error('WebGL unavailable');
    this.canvas = canvas; this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x08101d);
    this.camera = new THREE.PerspectiveCamera(29, 1, 0.1, 100); this.camera.position.set(0, 1.15, 6.6);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); this.renderer.shadowMap.enabled = true; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.clock = new THREE.Clock(); this.gesture = 'idle'; this.phase = 0; this.build(); this.resize();
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.frame = this.frame.bind(this); requestAnimationFrame(this.frame);
  }

  build() {
    this.scene.add(new THREE.HemisphereLight(0xcceeff, 0x050914, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.5); key.position.set(3, 5, 5); key.castShadow = true; this.scene.add(key);
    const rim = new THREE.PointLight(cyan, 16, 8); rim.position.set(-3, 2.8, 2); this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.9, 48), makeMaterial(0x062335)); floor.rotation.x = -Math.PI / 2; floor.position.y = -1.92; this.scene.add(floor);
    this.avatar = new THREE.Group(); this.scene.add(this.avatar);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.67, 1.05, 6, 16), makeMaterial(0x102640)); torso.position.y = -0.12; torso.scale.y = 1.25; torso.castShadow = true; this.avatar.add(torso);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.3, 14), makeMaterial(skin)); neck.position.y = 1; this.avatar.add(neck);
    this.head = new THREE.Group(); this.head.position.y = 1.55; this.avatar.add(this.head);
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.48, 24, 18), makeMaterial(skin)); face.scale.set(0.88, 1.08, 0.88); face.castShadow = true; this.head.add(face);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16, 0, Math.PI * 2, 0, 1.7), makeMaterial(0x102033)); hair.position.y = 0.17; hair.scale.set(0.92, 0.62, 0.9); this.head.add(hair);
    this.eyes = [-1, 1].map(side => { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), makeMaterial(0x06111f)); eye.position.set(side * 0.16, 0.05, 0.42); this.head.add(eye); return eye; });
    this.mouth = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.012, 6, 18, Math.PI), makeMaterial(0x9b504a)); this.mouth.position.set(0, -0.18, 0.415); this.mouth.rotation.z = Math.PI; this.head.add(this.mouth);
    this.left = createArm(-1); this.right = createArm(1); this.avatar.add(this.left.root, this.right.root);
  }

  setGesture(gesture, phase = 0) { this.gesture = ALIASES[gesture] || gesture || 'idle'; this.phase = phase; }
  resize() { const rect = this.canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; this.renderer.setSize(rect.width, rect.height, false); this.camera.aspect = rect.width / rect.height; this.camera.updateProjectionMatrix(); }
  frame() {
    const elapsed = this.clock.getElapsedTime(), letter = LETTER_SHAPES[this.gesture];
    const current = POSES[this.gesture] || { right: calm(0.55, 0.6, letter || 'open'), left: calm(-0.55, 0.35, 'relaxed'), mood: 'neutral', motion: 'none' };
    const phase = this.gesture === 'idle' ? (elapsed * 0.12) % 1 : this.phase;
    poseArm(this.right, current.right, phase, current.motion); poseArm(this.left, current.left, phase, current.motion);
    [this.left, this.right].forEach(arm => [...arm.hand.fingers, arm.hand.thumb].forEach(finger => finger.joints.forEach(joint => { joint.rotation.x = THREE.MathUtils.lerp(joint.rotation.x, joint.userData.bend || 0, 0.25); })));
    const blink = Math.sin(elapsed * 2.2) > 0.985 ? 0.15 : 1; this.eyes.forEach(eye => { eye.scale.y = blink; });
    this.mouth.rotation.z = current.mood === 'happy' ? 0 : Math.PI; this.mouth.scale.y = current.mood === 'alert' ? 0.35 : 1;
    this.avatar.position.y = Math.sin(elapsed * 2.1) * 0.018; this.avatar.rotation.y = Math.sin(elapsed * 0.42) * 0.055;
    this.renderer.render(this.scene, this.camera); requestAnimationFrame(this.frame);
  }
}

window.SignBridgeAvatar3D = { mount: canvas => new WebGLAvatar(canvas) };
window.dispatchEvent(new Event('signbridge-avatar3d-ready'));
