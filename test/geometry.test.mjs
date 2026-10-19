import test from 'node:test';
import assert from 'node:assert/strict';

import { SPECS, PAPERS, mmToPx, pxToMm } from '../js/specs.js';
import {
  computeCrop,
  cropOverflow,
  hasOverflow,
  faceLengthMM,
  packSheet,
  eyeTiltRadians,
  rotatePoint,
  estimateHeadTop,
} from '../js/geometry.js';
import { evaluate, measureBackground, PASS, WARN, FAIL } from '../js/quality.js';

const DPI = 300;

test('mm→px: 외교부 권장 해상도 413x531 과 일치해야 한다', () => {
  assert.equal(mmToPx(35, DPI), 413);
  assert.equal(mmToPx(45, DPI), 531);
  // 4x6 인치 인화지
  assert.equal(mmToPx(PAPERS['4x6'].widthMM, DPI), 1800);
  assert.equal(mmToPx(PAPERS['4x6'].heightMM, DPI), 1200);
});

test('px→mm 은 mm→px 의 역이다', () => {
  assert.ok(Math.abs(pxToMm(mmToPx(34, DPI), DPI) - 34) < 0.1);
});

test('computeCrop: 결과물의 얼굴 길이가 목표치와 일치한다', () => {
  const spec = SPECS.passport;
  const headTopY = 100;
  const chinY = 500;
  const crop = computeCrop({ headTopY, chinY, centerX: 400, spec, dpi: DPI });

  const resultFaceMM = faceLengthMM(chinY - headTopY, crop.scale, DPI);
  assert.ok(
    resultFaceMM >= spec.faceMinMM && resultFaceMM <= spec.faceMaxMM,
    `얼굴 ${resultFaceMM}mm 가 규격 ${spec.faceMinMM}~${spec.faceMaxMM}mm 밖`,
  );
  assert.ok(Math.abs(resultFaceMM - spec.faceTargetMM) < 0.2);
});

test('computeCrop: 출력 크기가 규격 픽셀과 같다', () => {
  const crop = computeCrop({ headTopY: 50, chinY: 450, centerX: 300, spec: SPECS.passport, dpi: DPI });
  assert.equal(crop.outW, 413);
  assert.equal(crop.outH, 531);
});

test('computeCrop: 정수리가 결과물 상단에서 규격 여백만큼 떨어진다', () => {
  const spec = SPECS.passport;
  const headTopY = 200;
  const crop = computeCrop({ headTopY, chinY: 600, centerX: 400, spec, dpi: DPI });
  // 원본의 정수리가 결과물에서 어디에 오는가
  const headTopInOutput = (headTopY - crop.sy) * crop.scale;
  assert.ok(
    Math.abs(headTopInOutput - mmToPx(spec.topMarginMM, DPI)) < 1,
    `정수리 위치 ${headTopInOutput}px, 기대 ${mmToPx(spec.topMarginMM, DPI)}px`,
  );
});

test('computeCrop: 크롭 영역의 가로 중심이 지정한 중심과 같다', () => {
  const crop = computeCrop({ headTopY: 100, chinY: 500, centerX: 640, spec: SPECS.resume, dpi: DPI });
  assert.ok(Math.abs(crop.sx + crop.sWidth / 2 - 640) < 0.001);
});

test('computeCrop: 턱이 정수리보다 위면 거부한다', () => {
  assert.throws(() =>
    computeCrop({ headTopY: 500, chinY: 100, centerX: 300, spec: SPECS.passport, dpi: DPI }),
  );
});

test('cropOverflow: 얼굴을 꽉 채워 찍은 셀카에서 여백 부족을 잡아낸다', () => {
  // 640x480 사진에 얼굴이 거의 가득 찬 상황
  const crop = computeCrop({ headTopY: 20, chinY: 440, centerX: 320, spec: SPECS.passport, dpi: DPI });
  const over = cropOverflow(crop, 640, 480);
  assert.ok(hasOverflow(over), '여백 부족이 감지되어야 한다');
  assert.ok(over.top > 0, '위쪽이 모자라야 한다');
});

test('cropOverflow: 넉넉히 찍은 사진은 넘치지 않는다', () => {
  const crop = computeCrop({ headTopY: 300, chinY: 700, centerX: 800, spec: SPECS.passport, dpi: DPI });
  const over = cropOverflow(crop, 1600, 1600);
  assert.equal(hasOverflow(over), false);
});

test('packSheet: 4x6 인화지에 35x45 증명사진 8장이 들어간다', () => {
  const s = packSheet({
    paper: PAPERS['4x6'],
    photoWidthMM: 35,
    photoHeightMM: 45,
    dpi: DPI,
  });
  assert.equal(s.cols, 4);
  assert.equal(s.rows, 2);
  assert.equal(s.count, 8);
  assert.equal(s.cells.length, 8);
});

test('packSheet: 칸이 인화지 밖으로 나가지 않는다', () => {
  for (const key of Object.keys(PAPERS)) {
    for (const spec of Object.values(SPECS)) {
      const s = packSheet({
        paper: PAPERS[key],
        photoWidthMM: spec.widthMM,
        photoHeightMM: spec.heightMM,
        dpi: DPI,
      });
      for (const c of s.cells) {
        assert.ok(c.x >= 0 && c.y >= 0, `${key}/${spec.id}: 칸이 음수 좌표`);
        assert.ok(c.x + c.w <= s.sheetW, `${key}/${spec.id}: 가로 넘침`);
        assert.ok(c.y + c.h <= s.sheetH, `${key}/${spec.id}: 세로 넘침`);
      }
      assert.ok(s.count > 0, `${key}/${spec.id}: 한 장도 못 넣음`);
    }
  }
});

test('packSheet: 칸끼리 겹치지 않는다', () => {
  const s = packSheet({ paper: PAPERS['4x6'], photoWidthMM: 35, photoHeightMM: 45, dpi: DPI });
  for (let i = 0; i < s.cells.length; i++) {
    for (let j = i + 1; j < s.cells.length; j++) {
      const a = s.cells[i];
      const b = s.cells[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${i}번과 ${j}번 칸이 겹침`);
    }
  }
});

test('eyeTiltRadians: 수평이면 0, 오른쪽이 내려가면 양수', () => {
  assert.equal(eyeTiltRadians({ x: 0, y: 100 }, { x: 100, y: 100 }), 0);
  assert.ok(eyeTiltRadians({ x: 0, y: 100 }, { x: 100, y: 110 }) > 0);
});

test('rotatePoint: 기울어진 눈을 반대로 돌리면 수평이 된다', () => {
  const left = { x: 100, y: 100 };
  const right = { x: 200, y: 120 };
  const angle = eyeTiltRadians(left, right);
  const origin = { x: 150, y: 110 };
  const l2 = rotatePoint(left, -angle, origin);
  const r2 = rotatePoint(right, -angle, origin);
  assert.ok(Math.abs(l2.y - r2.y) < 1e-9, '회전 후 두 눈 높이가 같아야 한다');
});

test('estimateHeadTop: 이마보다 위쪽을 가리킨다', () => {
  const top = estimateHeadTop(200, 600);
  assert.ok(top < 200);
  assert.ok(Math.abs(top - (200 - 100)) < 1e-9); // (600-200)*0.25 = 100
});

test('evaluate: 모든 조건이 좋으면 통과', () => {
  const r = evaluate({
    faceMM: 34,
    tiltDeg: 0.5,
    scale: 0.8,
    overflow: { left: 0, top: 0, right: 0, bottom: 0 },
    background: { meanLuma: 250, stdev: 5 },
    spec: SPECS.passport,
  });
  assert.equal(r.status, PASS);
});

test('evaluate: 얼굴이 규격을 벗어나면 실패', () => {
  const r = evaluate({
    faceMM: 28,
    tiltDeg: 0,
    scale: 1,
    overflow: { left: 0, top: 0, right: 0, bottom: 0 },
    background: { meanLuma: 250, stdev: 5 },
    spec: SPECS.passport,
  });
  assert.equal(r.status, FAIL);
  assert.equal(r.items.find((i) => i.key === 'face').status, FAIL);
});

test('evaluate: 어두운 배경은 여권 모드에서 실패로 잡힌다', () => {
  const r = evaluate({
    faceMM: 34,
    tiltDeg: 0,
    scale: 1,
    overflow: { left: 0, top: 0, right: 0, bottom: 0 },
    background: { meanLuma: 150, stdev: 5 },
    spec: SPECS.passport,
  });
  assert.equal(r.items.find((i) => i.key === 'bg').status, FAIL);
});

test('evaluate: 일반 증명사진 모드는 배경을 검사하지 않는다', () => {
  const r = evaluate({
    faceMM: 33,
    tiltDeg: 0,
    scale: 1,
    overflow: { left: 0, top: 0, right: 0, bottom: 0 },
    background: { meanLuma: 20, stdev: 60 },
    spec: SPECS.resume,
  });
  assert.equal(r.items.find((i) => i.key === 'bg'), undefined);
  assert.equal(r.status, PASS);
});

test('measureBackground: 사람 영역을 빼고 배경만 잰다', () => {
  // 4픽셀: 앞 2개는 사람(검정), 뒤 2개는 배경(흰색)
  const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  const mask = new Float32Array([1, 1, 0, 0]);
  // 표본이 100개 미만이라 null 이 나오는 게 정상
  assert.equal(measureBackground(rgba, mask), null);

  // 표본을 충분히 준 경우
  const n = 400;
  const rgba2 = new Uint8ClampedArray(n * 4);
  const mask2 = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const person = p < n / 2;
    mask2[p] = person ? 1 : 0;
    const v = person ? 0 : 250;
    rgba2[p * 4] = v;
    rgba2[p * 4 + 1] = v;
    rgba2[p * 4 + 2] = v;
    rgba2[p * 4 + 3] = 255;
  }
  const m = measureBackground(rgba2, mask2);
  assert.ok(Math.abs(m.meanLuma - 250) < 1, `배경 평균이 250이어야 하는데 ${m.meanLuma}`);
  assert.ok(m.stdev < 1);
  assert.equal(m.samples, n / 2);
});
