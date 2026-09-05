/*
 * 소재 데이터베이스
 *
 * 절단 모델 : 필요 선(線)에너지 E[J/mm] = k * 두께^exp * factor[장비종류]
 * 조각 모델 : 필요 면(面)에너지 D[J/mm2] = density * engraveFactor[장비종류]
 *
 * k / density 값은 CO2 장비 실측 설정값(예: 60W, 3mm 자작합판 70% / 20mm/s)에서
 * 역산한 계수입니다. factor 가 null 이면 그 장비로는 해당 가공이 불가능합니다.
 */

const MACHINE_PRESETS = [
  { id: "diode-5", label: "다이오드 5W (광출력)", type: "diode", watt: 5, maxSpeed: 200 },
  { id: "diode-10", label: "다이오드 10W (광출력)", type: "diode", watt: 10, maxSpeed: 250 },
  { id: "diode-20", label: "다이오드 20W (광출력)", type: "diode", watt: 20, maxSpeed: 300 },
  { id: "diode-40", label: "다이오드 40W (광출력)", type: "diode", watt: 40, maxSpeed: 300 },
  { id: "co2-40", label: "CO2 40W (K40급)", type: "co2", watt: 40, maxSpeed: 300 },
  { id: "co2-60", label: "CO2 60W", type: "co2", watt: 60, maxSpeed: 400 },
  { id: "co2-80", label: "CO2 80W", type: "co2", watt: 80, maxSpeed: 500 },
  { id: "co2-100", label: "CO2 100W", type: "co2", watt: 100, maxSpeed: 600 },
  { id: "co2-130", label: "CO2 130W", type: "co2", watt: 130, maxSpeed: 600 },
  { id: "fiber-20", label: "파이버 20W (금속 마킹)", type: "fiber", watt: 20, maxSpeed: 3000 },
  { id: "fiber-30", label: "파이버 30W MOPA", type: "fiber", watt: 30, maxSpeed: 4000 },
  { id: "fiber-50", label: "파이버 50W MOPA", type: "fiber", watt: 50, maxSpeed: 5000 },
];

const MACHINE_TYPE_INFO = {
  diode: {
    label: "다이오드 (450nm 청색)",
    powerCapPct: 100,
    minPowerPct: 5,
    minSpeed: 1.5,
    maxPasses: 8,
    hint: "출력은 '광출력(optical)' 기준입니다. 입력 전력(예: 40W 소비전력)이 아니라 모듈 사양서의 광출력을 넣으세요.",
  },
  co2: {
    label: "CO2 (10.6μm 적외선)",
    powerCapPct: 80,
    minPowerPct: 10,
    minSpeed: 4,
    maxPasses: 6,
    hint: "튜브 수명을 위해 80% 이상 연속 사용은 피하고, 10% 미만은 방전이 불안정합니다.",
  },
  fiber: {
    label: "파이버 (1064nm, 금속 전용)",
    powerCapPct: 100,
    minPowerPct: 10,
    minSpeed: 100,
    maxPasses: 20,
    hint: "금속·일부 플라스틱 마킹 전용입니다. 목재/아크릴/가죽 절단에는 사용할 수 없습니다.",
  },
};

const MATERIALS = [
  /* ---------------- 목재 ---------------- */
  {
    id: "ply-birch", name: "자작나무 합판", category: "wood",
    desc: "가장 무난한 기본 소재. 절단면이 밝고 균일합니다.",
    thicknesses: [2, 3, 4, 5, 5.5, 9, 12],
    cut: { k: 0.575, exp: 1.15, kerf: 0.15, powerPct: { co2: 70, diode: 100 }, maxThickness: { co2: 20, diode: 6 } },
    engrave: { density: 0.47, dpi: 300, powerPct: { co2: 20, diode: 35 } },
    factor: { co2: 1, diode: 2.8, fiber: null },
    engraveFactor: { co2: 1, diode: 0.75, fiber: null },
    tips: ["에어어시스트를 켜면 그을음이 크게 줄어듭니다.", "마스킹 테이프를 붙이면 표면 그을음을 막을 수 있습니다."],
    warns: ["접착층이 두꺼운 저가 합판은 같은 두께라도 속도를 20% 낮춰야 합니다."],
  },
  {
    id: "mdf", name: "MDF", category: "wood",
    desc: "저렴하고 균일하지만 연기와 그을음이 많습니다.",
    thicknesses: [2.5, 3, 5, 9, 12, 15, 18],
    cut: { k: 0.78, exp: 1.15, kerf: 0.18, powerPct: { co2: 75, diode: 100 }, maxThickness: { co2: 18, diode: 5 } },
    engrave: { density: 0.5, dpi: 300, powerPct: { co2: 20, diode: 35 } },
    factor: { co2: 1, diode: 3.2, fiber: null },
    engraveFactor: { co2: 1, diode: 0.8, fiber: null },
    tips: ["절단면이 검게 타므로 마감(도색/사포)이 필요합니다."],
    warns: ["접착제(요소수지) 연기가 많습니다. 배기를 반드시 가동하세요."],
  },
  {
    id: "basswood", name: "바스우드(피나무) 판재", category: "wood",
    desc: "가볍고 잘 잘리는 모형용 판재. 저출력 장비에 가장 적합합니다.",
    thicknesses: [1.5, 2, 3, 4, 5, 6],
    cut: { k: 0.45, exp: 1.15, kerf: 0.13, powerPct: { co2: 70, diode: 100 }, maxThickness: { co2: 20, diode: 8 } },
    engrave: { density: 0.42, dpi: 300, powerPct: { co2: 18, diode: 30 } },
    factor: { co2: 1, diode: 2.6, fiber: null },
    engraveFactor: { co2: 1, diode: 0.7, fiber: null },
    tips: ["다이오드 입문자에게 권장하는 첫 소재입니다."], warns: [],
  },
  {
    id: "hardwood", name: "원목 판재 (오크·월넛·단풍)", category: "wood",
    desc: "밀도가 높아 같은 두께라도 합판보다 느립니다.",
    thicknesses: [3, 5, 8, 10],
    cut: { k: 0.88, exp: 1.15, kerf: 0.15, powerPct: { co2: 75, diode: 100 }, maxThickness: { co2: 15, diode: 4 } },
    engrave: { density: 0.55, dpi: 300, powerPct: { co2: 22, diode: 40 } },
    factor: { co2: 1, diode: 3.0, fiber: null },
    engraveFactor: { co2: 1, diode: 0.8, fiber: null },
    tips: ["나뭇결 방향에 따라 조각 농도가 달라집니다."], warns: [],
  },
  {
    id: "bamboo", name: "대나무 판재", category: "wood",
    desc: "단단하고 조각 대비가 좋아 도마·컵받침에 많이 쓰입니다.",
    thicknesses: [3, 5],
    cut: { k: 0.92, exp: 1.15, kerf: 0.15, powerPct: { co2: 75, diode: 100 }, maxThickness: { co2: 12, diode: 3 } },
    engrave: { density: 0.6, dpi: 300, powerPct: { co2: 25, diode: 45 } },
    factor: { co2: 1, diode: 3.0, fiber: null },
    engraveFactor: { co2: 1, diode: 0.75, fiber: null },
    tips: ["표면 오일을 닦아내면 조각 색이 균일해집니다."], warns: [],
  },
  {
    id: "cork", name: "코르크 시트", category: "wood",
    desc: "가볍고 빠르게 잘리지만 불이 붙기 쉽습니다.",
    thicknesses: [2, 3, 5],
    cut: { k: 0.32, exp: 1.1, kerf: 0.2, powerPct: { co2: 60, diode: 100 }, maxThickness: { co2: 10, diode: 4 } },
    engrave: { density: 0.4, dpi: 254, powerPct: { co2: 18, diode: 35 } },
    factor: { co2: 1, diode: 2.4, fiber: null },
    engraveFactor: { co2: 1, diode: 0.8, fiber: null },
    tips: [], warns: ["발화 위험이 있으니 절대 자리를 비우지 마세요."],
  },

  /* ---------------- 아크릴 ---------------- */
  {
    id: "acrylic-cast", name: "캐스트 아크릴 (투명)", category: "acrylic",
    desc: "절단면이 유리처럼 투명하게 나오는 대표 소재입니다.",
    thicknesses: [2, 3, 5, 8, 10, 15, 20],
    cut: { k: 0.62, exp: 1.15, kerf: 0.2, powerPct: { co2: 70, diode: null }, maxThickness: { co2: 25, diode: 0 } },
    engrave: { density: 0.35, dpi: 300, powerPct: { co2: 18, diode: null } },
    factor: { co2: 1, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: null, fiber: null },
    tips: ["에어어시스트를 약하게 하면 절단면이 더 맑게 나옵니다.", "캐스트(주조)는 조각 시 하얗게, 압출(사출)은 투명하게 남습니다."],
    warns: ["투명 아크릴은 450nm 청색광을 그대로 통과시켜 다이오드로는 가공되지 않습니다."],
  },
  {
    id: "acrylic-dark", name: "검정·불투명 컬러 아크릴", category: "acrylic",
    desc: "빛을 흡수하므로 다이오드 장비로도 가공할 수 있습니다.",
    thicknesses: [2, 3, 5, 8],
    cut: { k: 0.62, exp: 1.15, kerf: 0.2, powerPct: { co2: 70, diode: 100 }, maxThickness: { co2: 25, diode: 5 } },
    engrave: { density: 0.35, dpi: 300, powerPct: { co2: 18, diode: 30 } },
    factor: { co2: 1, diode: 3.2, fiber: null },
    engraveFactor: { co2: 1, diode: 1.1, fiber: null },
    tips: ["다이오드로 아크릴을 자를 때는 반드시 검정/불투명 계열을 고르세요."], warns: [],
  },
  {
    id: "acrylic-mirror", name: "미러 아크릴", category: "acrylic",
    desc: "뒷면(거울면) 조각으로 반사 문양을 만듭니다.",
    thicknesses: [2, 3],
    cut: { k: 0.66, exp: 1.15, kerf: 0.2, powerPct: { co2: 70, diode: null }, maxThickness: { co2: 8, diode: 0 } },
    engrave: { density: 0.3, dpi: 300, powerPct: { co2: 15, diode: null } },
    factor: { co2: 1, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: null, fiber: null },
    tips: ["도면을 좌우 반전해서 뒷면을 조각하세요."],
    warns: ["표면 반사로 다이오드 장비에서는 위험합니다. CO2만 사용하세요."],
  },

  /* ---------------- 종이·가죽·패브릭 ---------------- */
  {
    id: "paper", name: "종이 / 카드지", category: "paper",
    desc: "청첩장·카드용. 매우 빠르고 저출력으로 충분합니다.",
    thicknesses: [0.2, 0.3, 0.5],
    cut: { k: 0.12, exp: 1.0, kerf: 0.08, powerPct: { co2: 25, diode: 60 }, maxThickness: { co2: 2, diode: 1.5 } },
    engrave: { density: 0.15, dpi: 254, powerPct: { co2: 10, diode: 20 } },
    factor: { co2: 1, diode: 2.0, fiber: null },
    engraveFactor: { co2: 1, diode: 0.9, fiber: null },
    tips: ["종이가 들뜨지 않게 자석이나 허니컴 흡입으로 고정하세요."],
    warns: ["발화 위험이 가장 큰 소재입니다. 저출력·고속 설정을 지키세요."],
  },
  {
    id: "cardboard", name: "골판지 / 두꺼운 판지", category: "paper",
    desc: "시제품·포장 목업용.",
    thicknesses: [1, 2, 3],
    cut: { k: 0.18, exp: 1.05, kerf: 0.15, powerPct: { co2: 45, diode: 100 }, maxThickness: { co2: 8, diode: 4 } },
    engrave: { density: 0.2, dpi: 254, powerPct: { co2: 12, diode: 25 } },
    factor: { co2: 1, diode: 2.2, fiber: null },
    engraveFactor: { co2: 1, diode: 0.9, fiber: null },
    tips: [], warns: ["불이 잘 붙습니다. 반드시 감시하세요."],
  },
  {
    id: "leather-veg", name: "천연 소가죽 (베지터블)", category: "leather",
    desc: "각인 대비가 좋아 키링·카드지갑에 많이 쓰입니다.",
    thicknesses: [1, 1.5, 2, 3, 4],
    cut: { k: 0.42, exp: 1.1, kerf: 0.15, powerPct: { co2: 60, diode: 100 }, maxThickness: { co2: 6, diode: 3 } },
    engrave: { density: 0.4, dpi: 300, powerPct: { co2: 15, diode: 30 } },
    factor: { co2: 1, diode: 2.2, fiber: null },
    engraveFactor: { co2: 1, diode: 0.85, fiber: null },
    tips: ["냄새가 강하므로 배기를 최대로 하세요.", "물수건으로 표면을 살짝 닦으면 그을음이 덜 남습니다."],
    warns: ["크롬 무두질(크롬 탄) 가죽은 유해가스가 발생합니다. 베지터블 탄만 사용하세요."],
  },
  {
    id: "leather-pu", name: "인조가죽 (PU 계열)", category: "leather",
    desc: "PU 원단만 가능합니다. PVC 원단은 절대 금지입니다.",
    thicknesses: [0.8, 1.2, 1.5],
    cut: { k: 0.35, exp: 1.1, kerf: 0.15, powerPct: { co2: 50, diode: 100 }, maxThickness: { co2: 4, diode: 2 } },
    engrave: { density: 0.3, dpi: 300, powerPct: { co2: 12, diode: 25 } },
    factor: { co2: 1, diode: 2.4, fiber: null },
    engraveFactor: { co2: 1, diode: 0.9, fiber: null },
    tips: [],
    warns: ["원단 성분표를 반드시 확인하세요. PVC(염화비닐) 인조가죽은 염소가스가 나옵니다."],
  },
  {
    id: "felt", name: "폴리에스터 펠트", category: "fabric",
    desc: "절단면이 녹아 붙어 올이 풀리지 않습니다.",
    thicknesses: [1, 2, 3],
    cut: { k: 0.28, exp: 1.05, kerf: 0.2, powerPct: { co2: 45, diode: 100 }, maxThickness: { co2: 5, diode: 3 } },
    engrave: { density: 0.3, dpi: 254, powerPct: { co2: 12, diode: 25 } },
    factor: { co2: 1, diode: 2.5, fiber: null },
    engraveFactor: { co2: 1, diode: 0.9, fiber: null },
    tips: [], warns: [],
  },
  {
    id: "cotton", name: "면 / 캔버스 원단", category: "fabric",
    desc: "패치·아플리케용. 밝은 색은 다이오드 흡수율이 낮습니다.",
    thicknesses: [0.3, 0.5, 0.8],
    cut: { k: 0.12, exp: 1.0, kerf: 0.1, powerPct: { co2: 30, diode: 80 }, maxThickness: { co2: 3, diode: 1.5 } },
    engrave: { density: 0.2, dpi: 254, powerPct: { co2: 10, diode: 25 } },
    factor: { co2: 1, diode: 3.5, fiber: null },
    engraveFactor: { co2: 1, diode: 1.4, fiber: null },
    tips: [], warns: ["흰색·연한 색 원단은 다이오드에서 잘 반응하지 않습니다."],
  },

  /* ---------------- 고무·폼·플라스틱 ---------------- */
  {
    id: "rubber", name: "레이저 고무판 (도장용)", category: "rubber",
    desc: "스탬프 제작용. 깊게 파내는 조각이 핵심입니다.",
    thicknesses: [2.3, 3],
    cut: { k: 0.55, exp: 1.1, kerf: 0.3, powerPct: { co2: 65, diode: 100 }, maxThickness: { co2: 6, diode: 3 } },
    engrave: { density: 2.5, dpi: 200, powerPct: { co2: 60, diode: 100 } },
    factor: { co2: 1, diode: 2.6, fiber: null },
    engraveFactor: { co2: 1, diode: 1.6, fiber: null },
    tips: ["조각 깊이 확보를 위해 DPI를 200 이하로 낮추고 출력을 높입니다."],
    warns: ["냄새가 매우 강합니다. 배기 필수."],
  },
  {
    id: "eva", name: "EVA 폼 시트", category: "plastic",
    desc: "코스프레 소품·완충재용.",
    thicknesses: [2, 3, 5, 10],
    cut: { k: 0.3, exp: 1.1, kerf: 0.3, powerPct: { co2: 55, diode: 100 }, maxThickness: { co2: 12, diode: 4 } },
    engrave: { density: 0.4, dpi: 254, powerPct: { co2: 15, diode: 30 } },
    factor: { co2: 1, diode: 2.6, fiber: null },
    engraveFactor: { co2: 1, diode: 0.9, fiber: null },
    tips: [], warns: [],
  },
  {
    id: "delrin", name: "델린 / POM (아세탈)", category: "plastic",
    desc: "기계 부품용. 절단면이 깨끗하지만 환기가 중요합니다.",
    thicknesses: [1, 2, 3, 5],
    cut: { k: 0.95, exp: 1.15, kerf: 0.2, powerPct: { co2: 75, diode: null }, maxThickness: { co2: 8, diode: 0 } },
    engrave: { density: 0.6, dpi: 300, powerPct: { co2: 25, diode: null } },
    factor: { co2: 1, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: null, fiber: 1.0 },
    tips: [], warns: ["포름알데히드가 발생합니다. 배기를 충분히 하고 장시간 작업은 피하세요."],
  },

  /* ---------------- 석재·유리 (조각 전용) ---------------- */
  {
    id: "slate", name: "슬레이트 (컵받침·표지판)", category: "stone",
    desc: "표면이 하얗게 벗겨지며 대비가 강한 조각이 나옵니다.",
    thicknesses: [],
    cut: null,
    engrave: { density: 1.2, dpi: 300, powerPct: { co2: 45, diode: 100 } },
    factor: { co2: 1, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: 1.3, fiber: 1.0 },
    tips: ["조각 후 물티슈로 닦으면 대비가 살아납니다."], warns: [],
  },
  {
    id: "glass", name: "유리 (컵·병 마킹)", category: "stone",
    desc: "표면을 미세하게 깨뜨려 젖빛으로 만듭니다.",
    thicknesses: [],
    cut: null,
    engrave: { density: 1.5, dpi: 200, powerPct: { co2: 35, diode: null } },
    factor: { co2: 1, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: null, fiber: null },
    tips: ["젖은 신문지나 물비누를 얇게 발라두면 표면이 덜 깨집니다.", "DPI는 150~200으로 낮춰야 결과가 매끄럽습니다."],
    warns: ["강화유리는 조각 시 파손될 수 있습니다."],
  },
  {
    id: "tile", name: "세라믹 타일 (마킹 스프레이)", category: "stone",
    desc: "마킹 스프레이를 뿌린 뒤 소성하듯 검게 남깁니다.",
    thicknesses: [],
    cut: null,
    engrave: { density: 1.4, dpi: 300, powerPct: { co2: 60, diode: 100 } },
    factor: { co2: 1, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: 1.5, fiber: 1.0 },
    tips: ["전용 마킹 스프레이(몰리브덴계)를 얇게 2회 도포하세요."], warns: [],
  },

  /* ---------------- 금속 (파이버 / 마킹) ---------------- */
  {
    id: "anodized-alu", name: "아노다이즈드 알루미늄", category: "metal",
    desc: "피막을 벗겨 흰색 글자를 냅니다. CO2로도 마킹됩니다.",
    thicknesses: [],
    cut: null,
    engrave: { density: 0.9, dpi: 400, powerPct: { co2: 70, diode: null } },
    factor: { co2: null, diode: null, fiber: null },
    engraveFactor: { co2: 1, diode: null, fiber: 1.0 },
    fiber: { speed: 1500, powerPct: 40, freqKhz: 30, passes: 1, hatchMm: 0.03 },
    tips: ["CO2 장비는 아노다이징 피막만 벗길 수 있고, 생알루미늄에는 마킹되지 않습니다."], warns: [],
  },
  {
    id: "stainless", name: "스테인리스 스틸", category: "metal",
    desc: "파이버로 어닐링(검정)·각인 모두 가능합니다.",
    thicknesses: [],
    cut: null,
    engrave: { density: 3.0, dpi: 800, powerPct: { co2: null, diode: null } },
    factor: { co2: null, diode: null, fiber: null },
    engraveFactor: { co2: null, diode: null, fiber: 1.0 },
    fiber: { speed: 400, powerPct: 80, freqKhz: 40, passes: 2, hatchMm: 0.02 },
    tips: ["검정 어닐링은 저속·고주파(60~80kHz)·디포커스 0.5mm 조건에서 잘 나옵니다."],
    warns: ["CO2·다이오드 장비로는 마킹 스프레이를 쓰지 않는 한 가공되지 않습니다."],
  },
  {
    id: "brass", name: "황동 / 구리", category: "metal",
    desc: "반사율이 높아 파이버에서도 출력을 높여야 합니다.",
    thicknesses: [],
    cut: null,
    engrave: { density: 4.0, dpi: 800, powerPct: { co2: null, diode: null } },
    factor: { co2: null, diode: null, fiber: null },
    engraveFactor: { co2: null, diode: null, fiber: 1.0 },
    fiber: { speed: 300, powerPct: 90, freqKhz: 20, passes: 3, hatchMm: 0.02 },
    tips: [], warns: ["반사가 강하니 보호경 상태를 자주 점검하세요."],
  },
];

/* 절대 가공 금지 소재 */
const FORBIDDEN = [
  { name: "PVC / 염화비닐 (시트·타포린·인조가죽)", reason: "염소가스(HCl)가 발생해 호흡기를 상하게 하고, 장비 내부 금속과 렌즈를 부식시킵니다.", alt: "acrylic-dark" },
  { name: "폴리카보네이트 (PC, 렉산)", reason: "잘 잘리지 않고 심하게 변색·발화하며 유독가스가 나옵니다.", alt: "acrylic-cast" },
  { name: "ABS", reason: "녹아 늘어붙고 시안화수소를 포함한 유독가스가 발생합니다.", alt: "acrylic-dark" },
  { name: "PTFE (테플론)", reason: "불화수소가 발생합니다. 극소량도 매우 위험합니다.", alt: "delrin" },
  { name: "폴리스티렌 폼 / 스티로폼", reason: "즉시 발화합니다.", alt: "eva" },
  { name: "HDPE / 비닐봉지 계열", reason: "녹아서 불이 붙습니다.", alt: "eva" },
  { name: "유리섬유 / 카본 에폭시", reason: "에폭시 수지에서 유독가스가 나옵니다.", alt: "ply-birch" },
  { name: "크롬 무두질 가죽", reason: "6가 크롬을 포함한 발암성 연기가 발생합니다.", alt: "leather-veg" },
];

const CATEGORY_LABELS = {
  wood: "목재", acrylic: "아크릴", paper: "종이", leather: "가죽",
  fabric: "패브릭", rubber: "고무", plastic: "플라스틱", stone: "석재·유리", metal: "금속",
};

if (typeof module !== "undefined") {
  module.exports = { MATERIALS, FORBIDDEN, MACHINE_PRESETS, MACHINE_TYPE_INFO, CATEGORY_LABELS };
}
