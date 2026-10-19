/**
 * 규격 자가진단.
 *
 * 이 앱의 핵심 가치는 "배경을 지워주는 것"이 아니라
 * "이 사진 내면 반려당하는지 미리 알려주는 것"이다.
 * 그래서 판정 기준은 전부 숫자로 두고, 통과/경고/실패를 명확히 나눈다.
 */

/** 머리 기울임 허용치(도). 규격은 "머리 기울임 불가"라 넉넉히 주지 않는다. */
export const MAX_TILT_DEG = 3;

/** 배경 판정 기준 — 0~255 밝기 평균과 표준편차 */
export const BG_MIN_LUMA = 238;
export const BG_MAX_STDEV = 14;

/** 원본을 이 배율 이상으로 확대하면 인쇄 시 뭉갠 티가 난다 */
export const MAX_UPSCALE = 1.15;

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

export { PASS, WARN, FAIL };

/**
 * @param {object} m 측정값
 * @param {number} m.faceMM        결과물에서의 정수리~턱 길이(mm)
 * @param {number} m.tiltDeg       머리 기울기(도)
 * @param {number} m.scale         원본 대비 확대 배율
 * @param {object} m.overflow      cropOverflow() 결과
 * @param {?object} m.background   {meanLuma, stdev} — 측정 못했으면 null
 * @param {object} m.spec
 * @returns {{status:string, items:Array}}
 */
export function evaluate({ faceMM, tiltDeg, scale, overflow, background, spec }) {
  const items = [];

  // 1) 얼굴 길이 — 규격의 본체
  const faceRounded = Math.round(faceMM * 10) / 10;
  if (faceMM >= spec.faceMinMM && faceMM <= spec.faceMaxMM) {
    items.push({
      key: 'face',
      status: PASS,
      label: '얼굴 길이',
      detail: `${faceRounded}mm (기준 ${spec.faceMinMM}~${spec.faceMaxMM}mm)`,
    });
  } else {
    items.push({
      key: 'face',
      status: FAIL,
      label: '얼굴 길이',
      detail: `${faceRounded}mm — 기준 ${spec.faceMinMM}~${spec.faceMaxMM}mm 를 벗어남`,
      fix: '아래 크기 슬라이더로 맞춰주세요.',
    });
  }

  // 2) 기울기 — "머리 기울임 불가"
  const tiltRounded = Math.round(Math.abs(tiltDeg) * 10) / 10;
  if (tiltRounded <= MAX_TILT_DEG) {
    items.push({
      key: 'tilt',
      status: PASS,
      label: '머리 기울기',
      detail: `${tiltRounded}° (허용 ${MAX_TILT_DEG}° 이내)`,
    });
  } else {
    items.push({
      key: 'tilt',
      status: WARN,
      label: '머리 기울기',
      detail: `${tiltRounded}° — 허용 ${MAX_TILT_DEG}° 초과`,
      fix: '수평 맞추기를 켜거나, 고개를 세우고 다시 찍어주세요.',
    });
  }

  // 3) 여백 — 셀카에서 가장 흔한 탈락 사유
  const short = [];
  if (overflow.top > 0.5) short.push('위');
  if (overflow.bottom > 0.5) short.push('아래');
  if (overflow.left > 0.5 || overflow.right > 0.5) short.push('좌우');
  if (short.length === 0) {
    items.push({ key: 'margin', status: PASS, label: '여백', detail: '규격 영역이 사진 안에 들어옵니다' });
  } else {
    items.push({
      key: 'margin',
      status: FAIL,
      label: '여백',
      detail: `${short.join('·')} 공간이 모자랍니다`,
      fix: '30cm 정도 뒤로 물러나 가슴 위까지 나오게 다시 찍어주세요.',
    });
  }

  // 4) 해상도
  const scaleRounded = Math.round(scale * 100) / 100;
  if (scale <= 1) {
    items.push({ key: 'res', status: PASS, label: '해상도', detail: '축소 사용 — 인쇄 화질 충분' });
  } else if (scale <= MAX_UPSCALE) {
    items.push({ key: 'res', status: WARN, label: '해상도', detail: `${scaleRounded}배 확대 — 인쇄 시 약간 흐릴 수 있음` });
  } else {
    items.push({
      key: 'res',
      status: FAIL,
      label: '해상도',
      detail: `${scaleRounded}배 확대 — 인쇄하면 뭉개집니다`,
      fix: '더 가까이서, 또는 더 높은 화질로 다시 찍어주세요.',
    });
  }

  // 5) 배경 — 여권 모드에서만 의미가 있다(일반 모드는 어차피 교체하므로)
  if (!spec.allowBackgroundEdit) {
    if (!background) {
      items.push({ key: 'bg', status: WARN, label: '배경', detail: '측정하지 못했습니다 — 직접 확인해주세요' });
    } else {
      const luma = Math.round(background.meanLuma);
      const sd = Math.round(background.stdev);
      if (background.meanLuma >= BG_MIN_LUMA && background.stdev <= BG_MAX_STDEV) {
        items.push({ key: 'bg', status: PASS, label: '배경', detail: `균일한 흰색 (밝기 ${luma})` });
      } else if (background.meanLuma < BG_MIN_LUMA) {
        items.push({
          key: 'bg',
          status: FAIL,
          label: '배경',
          detail: `밝기 ${luma} — 흰색으로 보기 어렵습니다`,
          fix: '흰 벽이나 흰 종이 앞에서, 벽과 30cm 이상 떨어져 그림자를 없애고 찍어주세요.',
        });
      } else {
        items.push({
          key: 'bg',
          status: FAIL,
          label: '배경',
          detail: `얼룩·그림자 감지 (편차 ${sd})`,
          fix: '벽에서 조금 떨어지고, 정면에서 고르게 빛이 오도록 해주세요.',
        });
      }
    }
  }

  const status = items.some((i) => i.status === FAIL)
    ? FAIL
    : items.some((i) => i.status === WARN)
      ? WARN
      : PASS;

  return { status, items };
}

/**
 * 마스크의 배경 영역 픽셀로 밝기 평균/표준편차를 낸다.
 * @param {Uint8ClampedArray} rgba  결과물 캔버스 픽셀
 * @param {Uint8Array|Float32Array} mask  같은 크기, 값이 클수록 사람
 * @param {number} personThreshold 이 값 미만이면 배경으로 본다(0~1 정규화 기준)
 */
export function measureBackground(rgba, mask, personThreshold = 0.3) {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    if (mask[p] >= personThreshold) continue; // 사람 영역은 제외
    // Rec. 601 휘도
    const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    sum += luma;
    sumSq += luma * luma;
    n++;
  }
  if (n < 100) return null; // 표본이 너무 적으면 판정하지 않는다(오판보다 침묵)
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { meanLuma: mean, stdev: Math.sqrt(variance), samples: n };
}
