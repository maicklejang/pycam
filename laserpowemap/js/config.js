/*
 * 판매자 설정 파일 — 이 파일만 수정하면 상호/연락처/배송 정책이 앱 전체에 반영됩니다.
 */
const SHOP_CONFIG = {
  brand: "포유테크 레이저 가이드",
  brandShort: "레이저 가이드",   // 상단 바에 짧게 표시할 이름
  seller: "포유테크 (ForyouTech)",
  phone: "070-7510-4839",
  email: "order@example.com",
  kakaoChannel: "https://pf.kakao.com/_yourchannel",
  homepage: "https://example.com",
  bank: "○○은행 000-00-000000 (예금주)",
  currency: "원",
  shippingFee: 3500,
  freeShippingOver: 50000,
  // 주문서를 받을 서버가 있다면 URL을 넣으세요. 비워두면 공유/복사/메일로 전송합니다.
  orderEndpoint: "",
  notice: "표시된 값은 시작값입니다. 반드시 자투리 소재로 테스트 후 본작업하세요.",
};

const APP_VERSION = "1.2.0";

if (typeof module !== "undefined") module.exports = { SHOP_CONFIG, APP_VERSION };
