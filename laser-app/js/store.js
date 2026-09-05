/* 로컬 저장소 (장비 프로필 · 장바구니 · 테스트 기록 · 즐겨찾기) */
const Store = (function () {
  const P = "lmg.";
  function get(name, fallback) {
    try {
      const raw = localStorage.getItem(P + name);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function set(name, value) {
    try { localStorage.setItem(P + name, JSON.stringify(value)); } catch (e) {}
    return value;
  }

  const DEFAULT_MACHINE = { presetId: "diode-10", label: "다이오드 10W (광출력)", type: "diode", watt: 10, maxSpeed: 250 };

  return {
    get, set,
    machine: () => get("machine", DEFAULT_MACHINE),
    setMachine: (m) => set("machine", m),

    cart: () => get("cart", []),
    setCart: (c) => set("cart", c),
    addToCart(productId, variantId, qty) {
      const cart = get("cart", []);
      const hit = cart.find((i) => i.variantId === variantId);
      if (hit) hit.qty += qty || 1;
      else cart.push({ productId, variantId, qty: qty || 1 });
      return set("cart", cart);
    },
    removeFromCart(variantId) {
      return set("cart", get("cart", []).filter((i) => i.variantId !== variantId));
    },
    setQty(variantId, qty) {
      const cart = get("cart", []);
      const hit = cart.find((i) => i.variantId === variantId);
      if (hit) hit.qty = Math.max(1, qty);
      return set("cart", cart);
    },
    clearCart: () => set("cart", []),

    log: () => get("log", []),
    addLog(entry) {
      const log = get("log", []);
      log.unshift(Object.assign({ id: "L" + Date.now(), ts: new Date().toISOString() }, entry));
      return set("log", log.slice(0, 300));
    },
    removeLog(id) {
      return set("log", get("log", []).filter((e) => e.id !== id));
    },

    favorites: () => get("fav", []),
    toggleFavorite(id) {
      const fav = get("fav", []);
      const i = fav.indexOf(id);
      if (i >= 0) fav.splice(i, 1); else fav.push(id);
      return set("fav", fav);
    },
  };
})();
