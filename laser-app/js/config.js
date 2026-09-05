/*
 * 판매자 설정 파일 — 이 파일만 수정하면 상호/연락처/배송 정책이 앱 전체에 반영됩니다.
 */
const SHOP_CONFIG = {
  brand: "레이저 소재 가이드",
  seller: "○○레이저 (상호를 입력하세요)",
  phone: "010-0000-0000",
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

const APP_VERSION = "1.0.0";

if (typeof module !== "undefined") module.exports = { SHOP_CONFIG, APP_VERSION };
