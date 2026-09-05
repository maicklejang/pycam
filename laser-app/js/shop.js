/*
 * 판매 상품 목록 — 가격/재고/구성은 이 파일에서 관리합니다.
 * materialId 를 채워두면 설정 계산기 결과 화면에 "이 소재 구매하기"로 자동 연결됩니다.
 */
const PRODUCTS = [
  {
    id: "p-birch", materialId: "ply-birch", name: "자작나무 합판", badge: "베스트",
    desc: "레이저용 A급 자작합판. 접착층이 얇아 절단면이 깨끗합니다.",
    variants: [
      { id: "birch-3-300", label: "3mm / 300x200 / 5장", price: 12000, stock: "in" },
      { id: "birch-3-600", label: "3mm / 600x400 / 3장", price: 27000, stock: "in" },
      { id: "birch-5-300", label: "5.5mm / 300x200 / 5장", price: 19000, stock: "in" },
      { id: "birch-5-600", label: "5.5mm / 600x400 / 3장", price: 39000, stock: "low" },
    ],
  },
  {
    id: "p-basswood", materialId: "basswood", name: "바스우드 판재", badge: "입문 추천",
    desc: "다이오드 장비에서도 잘 잘리는 저밀도 판재. 첫 연습용으로 좋습니다.",
    variants: [
      { id: "bass-2-300", label: "2mm / 300x200 / 10장", price: 14000, stock: "in" },
      { id: "bass-3-300", label: "3mm / 300x200 / 10장", price: 18000, stock: "in" },
      { id: "bass-5-300", label: "5mm / 300x200 / 5장", price: 21000, stock: "in" },
    ],
  },
  {
    id: "p-mdf", materialId: "mdf", name: "MDF 보드",
    desc: "가성비 좋은 균질 소재. 시제품·연습용으로 많이 쓰입니다.",
    variants: [
      { id: "mdf-3-600", label: "3mm / 600x400 / 5장", price: 16000, stock: "in" },
      { id: "mdf-5-600", label: "5mm / 600x400 / 5장", price: 23000, stock: "in" },
    ],
  },
  {
    id: "p-acrylic-clear", materialId: "acrylic-cast", name: "캐스트 아크릴 (투명)", badge: "CO2 전용",
    desc: "절단면이 맑게 떨어지는 캐스트(주조) 아크릴. 보호필름 부착 상태로 발송합니다.",
    variants: [
      { id: "acc-3-300", label: "3mm / 300x200 / 3장", price: 15000, stock: "in" },
      { id: "acc-5-300", label: "5mm / 300x200 / 3장", price: 22000, stock: "in" },
      { id: "acc-3-600", label: "3mm / 600x400 / 2장", price: 32000, stock: "in" },
    ],
  },
  {
    id: "p-acrylic-dark", materialId: "acrylic-dark", name: "검정·컬러 아크릴", badge: "다이오드 가능",
    desc: "청색 다이오드로도 절단 가능한 불투명 아크릴입니다.",
    variants: [
      { id: "acd-2-300", label: "2mm / 300x200 / 3장", price: 14000, stock: "in" },
      { id: "acd-3-300", label: "3mm / 300x200 / 3장", price: 17000, stock: "in" },
    ],
  },
  {
    id: "p-leather", materialId: "leather-veg", name: "천연 소가죽 (베지터블)",
    desc: "크롬 무두질이 아닌 식물성 무두질 가죽. 각인 대비가 선명합니다.",
    variants: [
      { id: "lea-2-a4", label: "2mm / A4 크기 / 2장", price: 18000, stock: "in" },
      { id: "lea-3-a4", label: "3mm / A4 크기 / 2장", price: 24000, stock: "low" },
    ],
  },
  {
    id: "p-felt", materialId: "felt", name: "폴리에스터 펠트",
    desc: "절단면이 녹아 마감되어 올이 풀리지 않습니다.",
    variants: [
      { id: "fel-2-300", label: "2mm / 300x300 / 10장(혼합색)", price: 13000, stock: "in" },
    ],
  },
  {
    id: "p-slate", materialId: "slate", name: "슬레이트 컵받침",
    desc: "조각만으로 완제품이 되는 인기 품목입니다.",
    variants: [
      { id: "sla-100", label: "100x100 정사각 / 6개", price: 16000, stock: "in" },
      { id: "sla-round", label: "지름 100 원형 / 6개", price: 17000, stock: "in" },
    ],
  },
  {
    id: "p-rubber", materialId: "rubber", name: "레이저 고무판 (도장용)",
    desc: "스탬프 제작용 2.3mm 고무판입니다.",
    variants: [{ id: "rub-23", label: "2.3mm / 200x300 / 2장", price: 15000, stock: "in" }],
  },
  {
    id: "p-anodized", materialId: "anodized-alu", name: "아노다이즈드 알루미늄 명찰",
    desc: "CO2·파이버 모두 마킹 가능한 아노다이징 판. 검정/은색.",
    variants: [
      { id: "ano-name", label: "명찰용 70x30 / 10개", price: 14000, stock: "in" },
      { id: "ano-card", label: "카드 86x54 / 5개", price: 16000, stock: "in" },
    ],
  },
  /* ---- 소모품 · 액세서리 ---- */
  {
    id: "p-masking", materialId: null, name: "레이저 마스킹 테이프", badge: "소모품",
    desc: "표면 그을음을 막아주는 넓은 폭 종이 마스킹 테이프.",
    variants: [{ id: "msk-100", label: "100mm x 50m", price: 12000, stock: "in" }],
  },
  {
    id: "p-spray", materialId: "tile", name: "금속·타일 마킹 스프레이", badge: "소모품",
    desc: "CO2 장비로 금속·세라믹에 검은 마킹을 남길 때 사용합니다.",
    variants: [{ id: "spr-200", label: "200ml 1캔", price: 19000, stock: "in" }],
  },
  {
    id: "p-lens", materialId: null, name: "CO2 포커스 렌즈 / 미러 세트", badge: "소모품",
    desc: "소모된 렌즈는 절단력을 30% 이상 떨어뜨립니다.",
    variants: [
      { id: "lens-20", label: "초점거리 50.8mm 렌즈", price: 28000, stock: "in" },
      { id: "mir-set", label: "반사경 3개 세트", price: 24000, stock: "in" },
    ],
  },
  {
    id: "p-sample", materialId: null, name: "소재 테스트 샘플 팩", badge: "인기",
    desc: "합판·MDF·아크릴·가죽·펠트를 조금씩 담은 세팅값 검증용 팩입니다.",
    variants: [{ id: "smp-1", label: "6종 x 각 2장 (100x100)", price: 19000, stock: "in" }],
  },
];

const STOCK_LABELS = { in: "재고 있음", low: "소량 남음", out: "품절" };

if (typeof module !== "undefined") module.exports = { PRODUCTS, STOCK_LABELS };
