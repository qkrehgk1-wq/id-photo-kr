/**
 * 순수 계산 모듈 — DOM/canvas를 건드리지 않는다.
 *
 * 이 파일만 따로 node에서 테스트할 수 있게 유지한다.
 * 증명사진 앱에서 조용히 틀리기 쉬운 곳이 전부 여기(비율·크롭 좌표)라서,
 * 화면 없이 숫자로 검증되는 상태를 지킨다.
 */

import { mmToPx, pxToMm } from './specs.js?v=2';

/**
 * 두 눈을 잇는 선의 기울기(라디안).
 * 양수면 오른쪽 눈이 아래로 내려간 상태.
 */
export function eyeTiltRadians(leftEye, rightEye) {
  return Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
}

/** 점을 origin 기준으로 angle(라디안)만큼 회전 */
export function rotatePoint(p, angle, origin = { x: 0, y: 0 }) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

/**
 * 얼굴 랜드마크에는 '정수리'가 없다 — 메시는 이마 위쪽(10번)에서 끝난다.
 *
 * 외교부 규격의 머리 길이는 "정수리(머리카락을 제외한 머리 최상부)부터 턱까지"다
 * (passport.go.kr 2026-10-19 재확인). 머리카락 끝까지 재면 머리숱이 많은 사람일수록
 * 머리를 작게 잘라 3.2cm 미만 → 반려가 난다. (v1 은 마스크 맨 위=머리카락 끝을 썼다 — 버그)
 *
 * 그래서 두개골 꼭대기를 이마 끝~턱 길이의 HAIR_RATIO 만큼 위로 어림한다.
 * 성인 두부 계측상 머리선~정수리가 얼굴 길이의 약 1/4 이라는 근사치(오차 ±5% 안팎, 추정).
 */
export const HAIR_RATIO = 0.25;

/**
 * 머리카락을 뺀 정수리 y.
 * 어림값이 머리카락 끝(maskTopY)보다 위로 갈 수는 없다(두개골이 머리카락 밖으로 나올 수 없음).
 * 짧은 머리·민머리처럼 마스크 끝이 어림값보다 아래면 마스크 끝이 더 정확하다.
 * → 둘 중 아래쪽(y 가 큰 쪽)을 쓴다.
 */
export function skullTop(foreheadY, chinY, maskTopY = null, ratio = HAIR_RATIO) {
  const est = estimateHeadTop(foreheadY, chinY, ratio);
  if (maskTopY === null || maskTopY === undefined || !(maskTopY < chinY)) return { y: est, clamped: false };
  return maskTopY > est ? { y: maskTopY, clamped: true } : { y: est, clamped: false };
}

export function estimateHeadTop(foreheadY, chinY, ratio = HAIR_RATIO) {
  return foreheadY - (chinY - foreheadY) * ratio;
}

/**
 * 크롭 영역 계산.
 *
 * 규격이 요구하는 것은 두 가지다.
 *   1) 정수리~턱 길이 = faceTargetMM
 *   2) 사진 위쪽 여백 = topMarginMM
 * 이 둘이 정해지면 배율과 잘라낼 위치가 유일하게 결정된다.
 *
 * @returns {{sx,sy,sWidth,sHeight,outW,outH,scale}} sx/sy는 원본 이미지 좌표(음수 가능)
 */
export function computeCrop({ headTopY, chinY, centerX, spec, dpi }) {
  const faceSrcPx = chinY - headTopY;
  if (!(faceSrcPx > 0)) {
    throw new Error('턱이 정수리보다 위에 있습니다 — 얼굴 인식 결과가 잘못되었습니다.');
  }

  const outW = mmToPx(spec.widthMM, dpi);
  const outH = mmToPx(spec.heightMM, dpi);
  const faceTargetPx = mmToPx(spec.faceTargetMM, dpi);
  const topMarginPx = mmToPx(spec.topMarginMM, dpi);

  // 원본 1px이 결과물에서 몇 px이 되는지
  const scale = faceTargetPx / faceSrcPx;

  const sWidth = outW / scale;
  const sHeight = outH / scale;
  const sy = headTopY - topMarginPx / scale;
  const sx = centerX - sWidth / 2;

  return { sx, sy, sWidth, sHeight, outW, outH, scale };
}

/**
 * 크롭이 원본 밖으로 얼마나 삐져나가는지(px, 원본 기준).
 * 셀카는 대개 얼굴을 꽉 채워 찍어서 위/옆이 모자란다 — 그때 재촬영을 안내하려고 잰다.
 */
export function cropOverflow(crop, imgWidth, imgHeight) {
  return {
    left: Math.max(0, -crop.sx),
    top: Math.max(0, -crop.sy),
    right: Math.max(0, crop.sx + crop.sWidth - imgWidth),
    bottom: Math.max(0, crop.sy + crop.sHeight - imgHeight),
  };
}

export function hasOverflow(overflow) {
  return overflow.left > 0.5 || overflow.top > 0.5 || overflow.right > 0.5 || overflow.bottom > 0.5;
}

/**
 * 결과물에서 얼굴이 실제로 몇 mm인지.
 * 사용자가 배율을 직접 조정한 뒤에도 규격 안에 있는지 확인하는 데 쓴다.
 */
export function faceLengthMM(faceSrcPx, scale, dpi) {
  return pxToMm(faceSrcPx * scale, dpi);
}

/**
 * 인화지에 사진을 몇 장 배치할 수 있는지와 각 칸의 좌표.
 * 편의점 무인출력은 4x6이 기본이라, 여기서 최대한 많이 뽑아내는 게 이 앱의 실익이다.
 */
export function packSheet({ paper, photoWidthMM, photoHeightMM, dpi, gapMM = 1, marginMM = 3 }) {
  const sheetW = mmToPx(paper.widthMM, dpi);
  const sheetH = mmToPx(paper.heightMM, dpi);
  const pw = mmToPx(photoWidthMM, dpi);
  const ph = mmToPx(photoHeightMM, dpi);
  const gap = mmToPx(gapMM, dpi);
  const margin = mmToPx(marginMM, dpi);

  const usableW = sheetW - margin * 2;
  const usableH = sheetH - margin * 2;

  // n장 놓으려면 n*photo + (n-1)*gap <= usable
  const cols = Math.max(0, Math.floor((usableW + gap) / (pw + gap)));
  const rows = Math.max(0, Math.floor((usableH + gap) / (ph + gap)));

  const blockW = cols > 0 ? cols * pw + (cols - 1) * gap : 0;
  const blockH = rows > 0 ? rows * ph + (rows - 1) * gap : 0;
  const originX = Math.round((sheetW - blockW) / 2);
  const originY = Math.round((sheetH - blockH) / 2);

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: originX + c * (pw + gap),
        y: originY + r * (ph + gap),
        w: pw,
        h: ph,
      });
    }
  }

  return { sheetW, sheetH, cols, rows, count: cells.length, cells, photoW: pw, photoH: ph };
}
