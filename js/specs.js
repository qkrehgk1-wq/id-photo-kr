/**
 * 증명사진 규격 정의
 *
 * 출처(2026-08-04 확인):
 *  - 외교부 여권안내 https://www.passport.go.kr/home/kor/contents.do?menuPos=32
 *    · 3.5cm x 4.5cm, 정수리~턱 3.2~3.6cm, 균일한 흰색 배경
 *    · 온라인 신청용 권장 해상도 413 x 531 px
 *    · "편집 프로그램으로 배경 제거/합성 불가"  ← 여권 모드에서 배경 편집을 막는 근거
 *    · 무표정, 입 다물기, 정면, 머리 기울임 불가, 컬러렌즈/선글라스 불가
 *  2026-10-19 재확인으로 추가 반영:
 *    · 머리 길이의 정수리 = '머리카락을 제외한 머리 최상부' → geometry.skullTop
 *    · '편집 프로그램·필터로 임의 보정한 사진(AI 편집·합성 포함) 불가' → 여권 모드 자동 수평 보정 끔
 *
 * 일반 증명사진(이력서·사원증·학원 등)에는 위 배경 편집 금지 규정이 없다.
 * 그래서 모드를 나눈다 — 규정이 다른 것을 한 화면에서 같게 다루면 사용자가 반려당한다.
 */

export const MM_PER_INCH = 25.4;
export const DEFAULT_DPI = 300;

/** mm → 픽셀 (인쇄 기준 해상도) */
export function mmToPx(mm, dpi = DEFAULT_DPI) {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

/** 픽셀 → mm */
export function pxToMm(px, dpi = DEFAULT_DPI) {
  return (px / dpi) * MM_PER_INCH;
}

export const SPECS = {
  passport: {
    id: 'passport',
    label: '여권 · 주민등록증',
    sub: '외교부 규격 · 배경 편집 금지',
    widthMM: 35,
    heightMM: 45,
    faceMinMM: 32,
    faceMaxMM: 36,
    faceTargetMM: 34,
    topMarginMM: 4,
    // 공식 규격이 배경 합성을 금지한다. 앱이 임의로 지워주면 반려 사유가 된다.
    allowBackgroundEdit: false,
    // "사진 편집 프로그램 등으로 임의로 보정된 사진(AI 편집 포함) 허용 불가"(2026-10-19 재확인).
    // 사진을 돌려 머리를 세우는 것도 보정이고, 돌리면 기울기 검사가 늘 통과로 보이는 문제도 있다 → 여권 모드에서 끈다.
    allowAutoLevel: false,
    // "입은 다물어야 하며(치아 노출 불가), 미소 짓지 않는 무표정"
    checkExpression: true,
    warn: '여권·신분증 사진은 배경을 지우거나 합성·보정하면 반려됩니다. 흰 벽 앞에서 고개를 바로 하고 찍어주세요. 이 모드는 자르기와 규격 검사만 합니다(사진 돌리기도 하지 않음).',
  },
  resume: {
    id: 'resume',
    label: '일반 증명사진',
    sub: '이력서 · 사원증 · 학원 · 각종 원서',
    widthMM: 35,
    heightMM: 45,
    faceMinMM: 30,
    faceMaxMM: 36,
    faceTargetMM: 33,
    topMarginMM: 5,
    allowBackgroundEdit: true,
  },
  half: {
    id: 'half',
    label: '반명함',
    sub: '3 x 4 cm',
    widthMM: 30,
    heightMM: 40,
    faceMinMM: 26,
    faceMaxMM: 32,
    faceTargetMM: 29,
    topMarginMM: 4,
    allowBackgroundEdit: true,
  },
};

/** 배경 교체 색상 — 일반 증명사진에서만 쓴다 */
export const BACKGROUNDS = {
  white: { id: 'white', label: '흰색', css: '#ffffff' },
  blue: { id: 'blue', label: '하늘색', css: '#dce9f5' },
  gray: { id: 'gray', label: '회색', css: '#e8e8e8' },
};

/** 인화지 규격 — 편의점/무인출력 기준 */
export const PAPERS = {
  '4x6': { id: '4x6', label: '4 x 6 인치 (편의점 표준)', widthMM: 152.4, heightMM: 101.6 },
  '5x7': { id: '5x7', label: '5 x 7 인치', widthMM: 177.8, heightMM: 127 },
};
