/**
 * 증명사진 규격 도우미 — 화면/카메라/모델 연결부
 *
 * 설계 원칙
 *  1) 사진은 기기 밖으로 나가지 않는다. 업로드 없음, 서버 없음.
 *     얼굴 사진은 민감정보라 서버에 두는 순간 책임이 생긴다 — 아예 안 받는 쪽을 택했다.
 *  2) fail-open. 얼굴 인식이나 배경 분할이 실패해도 앱은 계속 쓸 수 있어야 한다.
 *     자동이 안 되면 슬라이더로 수동 조정하게 하고, 무엇이 안 됐는지 말해준다.
 *  3) 규격 판정은 숫자로만. "예뻐 보인다"가 아니라 mm 단위로 통과/실패를 낸다.
 */

import { SPECS, BACKGROUNDS, PAPERS, DEFAULT_DPI, mmToPx } from './specs.js?v=2';
import {
  computeCrop,
  cropOverflow,
  faceLengthMM,
  packSheet,
  eyeTiltRadians,
  rotatePoint,
  estimateHeadTop,
  skullTop,
} from './geometry.js?v=2';
import { evaluate, measureBackground, PASS, WARN, FAIL } from './quality.js?v=2';

const MP_VERSION = '0.10.14';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_FACE =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_SEG =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';

// 얼굴 메시 인덱스
const IDX = { chin: 152, forehead: 10, eyeA: 33, eyeB: 263, cheekL: 234, cheekR: 454 };

// 원본이 너무 크면 메모리만 먹는다. 결과물이 413x531이라 이 정도면 충분하다.
const MAX_SOURCE_EDGE = 2000;

const $ = (id) => document.getElementById(id);

const state = {
  spec: SPECS.passport,
  source: null,       // 회전 보정까지 끝낸 작업용 캔버스
  mask: null,         // Float32Array, 1 = 사람
  points: null,       // {headTop, chin, centerX, tiltDeg} (작업 캔버스 좌표)
  autoLevel: true,
  userAutoLevel: true, // 사용자가 고른 값(여권 모드에서 잠시 꺼도 기억)
  bg: 'none',
  size: 1,
  offX: 0,
  offY: 0,
  rawImage: null,     // 원본 비트맵 (수평 보정 다시 계산할 때 필요)
  detection: null,    // {landmarks, maskRaw} 원본 좌표 기준
  lastCrop: null,
};

/* ─────────────────────────── 모델 로딩 (지연·실패 허용) ─────────────────────────── */

let visionPromise = null;
function loadVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const mp = await import(/* @vite-ignore */ MP_BUNDLE);
      const fileset = await mp.FilesetResolver.forVisionTasks(MP_WASM);
      const [face, seg] = await Promise.all([
        mp.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_FACE, delegate: 'GPU' },
          runningMode: 'IMAGE',
          numFaces: 1,
          outputFaceBlendshapes: true, // 표정(미소·입 벌림) 점검용
        }),
        mp.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_SEG, delegate: 'GPU' },
          runningMode: 'IMAGE',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        }).catch(() => null), // 분할은 없어도 앱이 돌아간다
      ]);
      return { face, seg };
    })().catch((err) => {
      console.warn('모델 로딩 실패', err);
      visionPromise = null;
      return null;
    });
  }
  return visionPromise;
}

/* ─────────────────────────── 마스크 처리 ─────────────────────────── */

/**
 * 카테고리 마스크의 사람/배경 값이 모델·버전에 따라 뒤집혀 나오는 일이 있다.
 * 사진 아래쪽 가운데는 사람일 확률이 압도적이므로, 거기를 보고 방향을 정한다.
 */
function normalizeMask(raw, w, h) {
  const out = new Float32Array(w * h);
  let nonZero = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > 0) nonZero++;
  const nonZeroRatio = nonZero / raw.length;

  // 아래쪽 가운데 표본
  let sampleNonZero = 0;
  let sampleTotal = 0;
  const y0 = Math.floor(h * 0.7);
  const x0 = Math.floor(w * 0.35);
  const x1 = Math.floor(w * 0.65);
  for (let y = y0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      if (raw[y * w + x] > 0) sampleNonZero++;
      sampleTotal++;
    }
  }
  const inverted = sampleTotal > 0 && sampleNonZero / sampleTotal < 0.5;

  for (let i = 0; i < out.length; i++) {
    const isPerson = inverted ? raw[i] === 0 : raw[i] > 0;
    out[i] = isPerson ? 1 : 0;
  }
  // 사람이 화면을 거의 다 덮거나 거의 없으면 분할이 실패한 것으로 본다
  const personRatio = inverted ? 1 - nonZeroRatio : nonZeroRatio;
  if (personRatio < 0.05 || personRatio > 0.95) return null;
  return out;
}

/** 마스크에서 머리카락 끝(가장 위쪽 사람 픽셀) 찾기 — 규격의 정수리는 이보다 아래(머리카락 제외)다 */
function headTopFromMask(mask, w, h, centerX) {
  const band = Math.max(8, Math.round(w * 0.16));
  const x0 = Math.max(0, Math.round(centerX - band));
  const x1 = Math.min(w, Math.round(centerX + band));
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = x0; x < x1; x++) {
      if (mask[y * w + x] > 0.5) {
        run++;
        // 잡티 한두 픽셀에 속지 않도록 연속으로 일정 폭 이상일 때만 인정
        if (run >= 6) return y;
      } else {
        run = 0;
      }
    }
  }
  return null;
}

/* ─────────────────────────── 이미지 준비 ─────────────────────────── */

function drawToCanvas(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

function fitSource(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  const k = longest > MAX_SOURCE_EDGE ? MAX_SOURCE_EDGE / longest : 1;
  return drawToCanvas(bitmap, Math.round(bitmap.width * k), Math.round(bitmap.height * k));
}

/** 캔버스를 angle 만큼 회전시켜 새 캔버스로. 좌표 변환 함수도 같이 돌려준다. */
function rotateCanvas(src, angle) {
  const w = src.width;
  const h = src.height;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const W = Math.round(w * cos + h * sin);
  const H = Math.round(w * sin + h * cos);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.translate(W / 2, H / 2);
  ctx.rotate(angle);
  ctx.drawImage(src, -w / 2, -h / 2);

  const map = (p) => {
    const r = rotatePoint(p, angle, { x: w / 2, y: h / 2 });
    return { x: r.x + (W - w) / 2, y: r.y + (H - h) / 2 };
  };
  return { canvas: c, map };
}

/**
 * 마스크를 '알파 채널'로 인코딩한다.
 * destination-in 합성은 알파만 보기 때문에, 색으로만 칠하면(알파 255) 아무것도 걸러지지 않는다.
 * 사람=불투명, 배경=투명.
 */
function maskToCanvas(mask, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    const person = mask[i] > 0.5;
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = person ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasToMask(c) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  // 알파로 인코딩했으므로 알파를 읽는다
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

/* ─────────────────────────── 분석 ─────────────────────────── */

async function analyze(bitmap) {
  state.rawImage = fitSource(bitmap);
  setStatus('얼굴을 찾는 중…');

  const vision = await loadVision();
  let landmarks = null;
  let maskRaw = null;
  let expression = null;

  if (vision?.face) {
    try {
      const res = vision.face.detect(state.rawImage);
      landmarks = res?.faceLandmarks?.[0] || null;
      const cats = res?.faceBlendshapes?.[0]?.categories;
      if (cats) {
        const s = Object.fromEntries(cats.map((c) => [c.categoryName, c.score]));
        expression = {
          smile: ((s.mouthSmileLeft || 0) + (s.mouthSmileRight || 0)) / 2,
          jawOpen: s.jawOpen || 0,
        };
      }
    } catch (e) {
      console.warn('얼굴 인식 실패', e);
    }
  }

  if (vision?.seg) {
    try {
      setStatus('사람과 배경을 구분하는 중…');
      const w = state.rawImage.width;
      const h = state.rawImage.height;
      const res = await new Promise((resolve) => {
        try {
          vision.seg.segment(state.rawImage, (r) => resolve(r));
        } catch (e) {
          resolve(null);
        }
      });
      const cat = res?.categoryMask;
      if (cat) {
        maskRaw = normalizeMask(cat.getAsUint8Array(), w, h);
        cat.close?.();
      }
    } catch (e) {
      console.warn('배경 분할 실패', e);
    }
  }

  state.detection = { landmarks, maskRaw, expression };
  rebuild();
}

/** 수평 보정 여부에 따라 작업 캔버스와 기준점을 다시 만든다 */
function rebuild() {
  const { landmarks, maskRaw } = state.detection || {};
  const src = state.rawImage;
  if (!src) return;

  const w = src.width;
  const h = src.height;
  let angle = 0;
  let tiltDeg = 0;

  if (landmarks) {
    const pts = [landmarks[IDX.eyeA], landmarks[IDX.eyeB]]
      .map((p) => ({ x: p.x * w, y: p.y * h }))
      .sort((a, b) => a.x - b.x);
    const t = eyeTiltRadians(pts[0], pts[1]);
    tiltDeg = (t * 180) / Math.PI;
    // 15도를 넘으면 인식이 잘못됐을 가능성이 크다 — 함부로 돌리지 않는다
    if (state.autoLevel && Math.abs(tiltDeg) > 1 && Math.abs(tiltDeg) <= 15) angle = -t;
  }

  const rot = angle !== 0 ? rotateCanvas(src, angle) : { canvas: src, map: (p) => p };
  state.source = rot.canvas;

  if (maskRaw) {
    if (angle !== 0) {
      const mc = rotateCanvas(maskToCanvas(maskRaw, w, h), angle);
      state.mask = canvasToMask(mc.canvas);
    } else {
      state.mask = maskRaw;
    }
  } else {
    state.mask = null;
  }

  if (landmarks) {
    const chin = rot.map({ x: landmarks[IDX.chin].x * w, y: landmarks[IDX.chin].y * h });
    const fore = rot.map({ x: landmarks[IDX.forehead].x * w, y: landmarks[IDX.forehead].y * h });
    const cl = rot.map({ x: landmarks[IDX.cheekL].x * w, y: landmarks[IDX.cheekL].y * h });
    const cr = rot.map({ x: landmarks[IDX.cheekR].x * w, y: landmarks[IDX.cheekR].y * h });
    const centerX = (cl.x + cr.x) / 2;

    // 규격의 정수리 = 머리카락을 제외한 머리 최상부. 이마에서 어림하고, 마스크(머리카락 끝)로 위쪽을 막는다.
    let maskTop = null;
    if (state.mask) {
      const y = headTopFromMask(state.mask, state.source.width, state.source.height, centerX);
      if (y !== null && y < chin.y) maskTop = y;
    }
    const st = skullTop(fore.y, chin.y, maskTop);
    const headTop = st.y;
    const headTopSource = st.clamped ? 'mask' : 'estimate';

    state.points = { headTop, chin: chin.y, centerX, tiltDeg, headTopSource };
  } else {
    // 얼굴을 못 찾아도 쓸 수 있게 — 화면 중앙 기준으로 대충 잡고 슬라이더로 맞추게 한다
    const W = state.source.width;
    const H = state.source.height;
    state.points = {
      headTop: H * 0.15,
      chin: H * 0.6,
      centerX: W / 2,
      tiltDeg: 0,
      headTopSource: 'none',
    };
  }

  render();
}

/* ─────────────────────────── 렌더링 ─────────────────────────── */

function render() {
  const src = state.source;
  const p = state.points;
  if (!src || !p) return;

  const spec = state.spec;
  const effSpec = { ...spec, faceTargetMM: spec.faceTargetMM * state.size };

  let crop;
  try {
    crop = computeCrop({
      headTopY: p.headTop,
      chinY: p.chin,
      centerX: p.centerX,
      spec: effSpec,
      dpi: DEFAULT_DPI,
    });
  } catch (e) {
    setStatus('얼굴 인식 결과가 이상합니다. 다시 찍어주세요.');
    return;
  }

  crop.sx += state.offX / crop.scale;
  crop.sy += state.offY / crop.scale;
  state.lastCrop = crop;

  const canvas = $('outCanvas');
  canvas.width = crop.outW;
  canvas.height = crop.outH;
  const ctx = canvas.getContext('2d');

  const replacing = spec.allowBackgroundEdit && state.bg !== 'none' && state.mask;

  // 밑바탕: 배경을 바꿀 땐 그 색, 아니면 흰색(원본 밖으로 나간 영역용)
  ctx.fillStyle = replacing ? BACKGROUNDS[state.bg].css : '#ffffff';
  ctx.fillRect(0, 0, crop.outW, crop.outH);

  ctx.imageSmoothingQuality = 'high';

  if (replacing) {
    // 사람만 오려서 새 배경 위에 얹는다
    const person = document.createElement('canvas');
    person.width = src.width;
    person.height = src.height;
    const pctx = person.getContext('2d');
    pctx.drawImage(src, 0, 0);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(maskToCanvas(state.mask, src.width, src.height), 0, 0);
    ctx.drawImage(person, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, crop.outW, crop.outH);
  } else {
    ctx.drawImage(src, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, crop.outW, crop.outH);
  }

  // ── 규격 판정
  const overflow = cropOverflow(crop, src.width, src.height);
  const faceMM = faceLengthMM(p.chin - p.headTop, crop.scale, DEFAULT_DPI);

  let background = null;
  if (!spec.allowBackgroundEdit && state.mask) {
    const outPixels = ctx.getImageData(0, 0, crop.outW, crop.outH).data;
    const cropMask = sampleMaskForCrop(state.mask, src.width, src.height, crop);
    background = measureBackground(outPixels, cropMask);
  }

  const result = evaluate({
    faceMM,
    tiltDeg: state.autoLevel ? 0 : p.tiltDeg,
    scale: crop.scale,
    overflow,
    background,
    spec,
    expression: state.detection?.expression || null,
  });

  paintChecks(result, p);
  $('valSize').textContent = `${Math.round(faceMM * 10) / 10}mm`;
  setStatus('');
}

/** 결과물 픽셀과 1:1로 맞는 마스크를 만든다 (배경 밝기를 재려면 좌표가 맞아야 한다) */
function sampleMaskForCrop(mask, w, h, crop) {
  const out = new Float32Array(crop.outW * crop.outH);
  for (let y = 0; y < crop.outH; y++) {
    const sy = Math.round(crop.sy + (y / crop.outH) * crop.sHeight);
    for (let x = 0; x < crop.outW; x++) {
      const sx = Math.round(crop.sx + (x / crop.outW) * crop.sWidth);
      out[y * crop.outW + x] =
        sx >= 0 && sy >= 0 && sx < w && sy < h ? mask[sy * w + sx] : 1; // 사진 밖은 배경 통계에서 제외
    }
  }
  return out;
}

function paintChecks(result, points) {
  const ul = $('checks');
  ul.innerHTML = '';
  const icon = { [PASS]: '✓', [WARN]: '!', [FAIL]: '✕' };

  for (const it of result.items) {
    const li = document.createElement('li');
    li.className = it.status;
    li.innerHTML = `<span class="ico">${icon[it.status]}</span><span><span class="lab">${it.label}</span> — ${it.detail}${
      it.fix ? `<span class="fix">${it.fix}</span>` : ''
    }</span>`;
    ul.appendChild(li);
  }

  if (points.headTopSource === 'none') {
    const li = document.createElement('li');
    li.className = 'warn';
    li.innerHTML =
      '<span class="ico">!</span><span><span class="lab">얼굴 자동 인식 실패</span> — 아래 슬라이더로 직접 맞춰주세요.<span class="fix">밝은 곳에서 정면으로 다시 찍으면 자동으로 잡힙니다.</span></span>';
    ul.appendChild(li);
  } else if (points.headTopSource === 'estimate') {
    const li = document.createElement('li');
    li.className = 'warn';
    li.innerHTML =
      '<span class="ico">i</span><span><span class="lab">정수리는 어림값</span> — 외교부 규격대로 머리카락을 뺀 머리 꼭대기를 이마 위치로 어림했습니다(±2mm 안팎).<span class="fix">머리숱이 많거나 앞머리가 이마를 덮으면 크기 슬라이더로 확인해주세요.</span></span>';
    ul.appendChild(li);
  }
}

/* ─────────────────────────── 저장 ─────────────────────────── */

function download(canvas, filename) {
  canvas.toBlob(
    (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    'image/jpeg',
    0.95,
  );
}

function buildSheet() {
  const spec = state.spec;
  const paper = PAPERS['4x6'];
  const layout = packSheet({
    paper,
    photoWidthMM: spec.widthMM,
    photoHeightMM: spec.heightMM,
    dpi: DEFAULT_DPI,
  });

  const c = document.createElement('canvas');
  c.width = layout.sheetW;
  c.height = layout.sheetH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  const photo = $('outCanvas');
  for (const cell of layout.cells) {
    ctx.drawImage(photo, cell.x, cell.y, cell.w, cell.h);
    // 자를 선 — 얇은 회색이라 가위질에는 보이고 인화물에는 거슬리지 않는다
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
  }
  return { canvas: c, count: layout.count };
}

/* ─────────────────────────── UI 배선 ─────────────────────────── */

function setStatus(msg) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function buildModes() {
  const box = $('modes');
  box.innerHTML = '';
  for (const spec of Object.values(SPECS)) {
    const b = document.createElement('button');
    b.className = 'mode';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(spec.id === state.spec.id));
    b.innerHTML = `<span><span class="t">${spec.label}</span><br><span class="s">${spec.sub}</span></span>`;
    b.addEventListener('click', () => {
      state.spec = spec;
      buildModes();
      applyModeUI();
      if (state.source) render();
    });
    box.appendChild(b);
  }
}

function applyModeUI() {
  const spec = state.spec;
  const notice = $('modeNotice');
  notice.classList.toggle('hidden', !spec.warn);
  if (spec.warn) notice.textContent = spec.warn;

  $('bgArea').classList.toggle('hidden', !spec.allowBackgroundEdit);
  if (!spec.allowBackgroundEdit) state.bg = 'none';

  // 여권 모드: 사진 돌리기(보정) 금지 — 체크 상자를 끄고 잠근다. 다른 모드로 가면 사용자 선택을 되살린다.
  const chk = $('chkLevel');
  const levelAllowed = spec.allowAutoLevel !== false;
  chk.disabled = !levelAllowed;
  chk.checked = levelAllowed ? state.userAutoLevel : false;
  $('levelNote').classList.toggle('hidden', levelAllowed);
  const want = levelAllowed ? state.userAutoLevel : false;
  if (state.autoLevel !== want) {
    state.autoLevel = want;
    if (state.source) rebuild();
  }

  const layout = packSheet({
    paper: PAPERS['4x6'],
    photoWidthMM: spec.widthMM,
    photoHeightMM: spec.heightMM,
    dpi: DEFAULT_DPI,
  });
  $('sheetHint').textContent =
    `인화시트는 4x6 인치 한 장에 ${layout.count}장이 들어갑니다. 편의점·무인출력 키오스크에 그대로 넣으면 됩니다.`;
}

function buildBgChips() {
  const box = $('bgChips');
  box.innerHTML = '';
  const opts = [{ id: 'none', label: '원본 그대로' }, ...Object.values(BACKGROUNDS)];
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = o.label;
    b.setAttribute('aria-pressed', String(state.bg === o.id));
    b.addEventListener('click', () => {
      if (o.id !== 'none' && !state.mask) {
        alert('배경을 구분하지 못했습니다. 원본 그대로 사용해주세요.');
        return;
      }
      state.bg = o.id;
      buildBgChips();
      render();
    });
    box.appendChild(b);
  }
}

async function handleImage(blobOrFile) {
  $('resultCard').classList.remove('hidden');
  setStatus('사진을 읽는 중…');
  try {
    // 폰 사진은 EXIF에 회전 정보가 들어있다.
    // 이 옵션을 빼면 세로로 찍은 사진이 옆으로 누운 채 들어온다.
    const bitmap = await createImageBitmap(blobOrFile, { imageOrientation: 'from-image' });
    state.size = 1;
    state.offX = 0;
    state.offY = 0;
    $('rngSize').value = '1';
    $('rngX').value = '0';
    $('rngY').value = '0';
    await analyze(bitmap);
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    setStatus('사진을 열지 못했습니다. 다른 사진으로 시도해주세요.');
  }
}

let stream = null;
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
    const v = $('video');
    v.srcObject = stream;
    await v.play();
    $('cameraArea').classList.remove('hidden');
  } catch (e) {
    alert('카메라를 열 수 없습니다. 브라우저 권한을 확인하시거나 앨범에서 골라주세요.');
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('cameraArea').classList.add('hidden');
}

function wire() {
  $('btnFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleImage(f);
    e.target.value = '';
  });

  $('btnCamera').addEventListener('click', startCamera);
  $('btnCancelCam').addEventListener('click', stopCamera);
  $('btnShoot').addEventListener('click', async () => {
    const v = $('video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    // 셀카는 좌우가 뒤집혀 보이므로 되돌려 저장한다
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0);
    stopCamera();
    c.toBlob((b) => handleImage(b), 'image/jpeg', 0.95);
  });

  const rerender = () => {
    state.size = parseFloat($('rngSize').value);
    state.offX = parseFloat($('rngX').value);
    state.offY = parseFloat($('rngY').value);
    render();
  };
  ['rngSize', 'rngX', 'rngY'].forEach((id) => $(id).addEventListener('input', rerender));

  $('chkLevel').addEventListener('change', (e) => {
    state.autoLevel = e.target.checked;
    state.userAutoLevel = e.target.checked;
    rebuild();
  });

  $('btnSaveOne').addEventListener('click', () => {
    download($('outCanvas'), `증명사진_${state.spec.label}_${state.spec.widthMM}x${state.spec.heightMM}.jpg`);
  });

  $('btnSaveSheet').addEventListener('click', () => {
    const { canvas, count } = buildSheet();
    download(canvas, `인화시트_4x6_${count}장.jpg`);
  });
}

buildModes();
applyModeUI();
buildBgChips();
wire();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
