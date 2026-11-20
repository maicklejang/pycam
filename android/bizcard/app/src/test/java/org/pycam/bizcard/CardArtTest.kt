package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CardArtTest {

    @Test
    fun `모르는 자리 값은 넣지 않기로 본다`() {
        assertEquals(LogoPlacement.SPOT_NONE, LogoPlacement.normalizeSpot("어딘가"))
        assertEquals(LogoPlacement.SPOT_TOP_LEFT, LogoPlacement.normalizeSpot(LogoPlacement.SPOT_TOP_LEFT))
    }

    @Test
    fun `로고 크기는 범위 안으로 맞춘다`() {
        assertEquals(LogoPlacement.MIN_SCALE, LogoPlacement.normalizeScale(0f), 0.0001f)
        assertEquals(LogoPlacement.MAX_SCALE, LogoPlacement.normalizeScale(9f), 0.0001f)
        assertEquals(0.25f, LogoPlacement.normalizeScale(0.25f), 0.0001f)
        assertEquals(LogoPlacement.DEFAULT_SCALE, LogoPlacement.normalizeScale(Float.NaN), 0.0001f)
    }

    @Test
    fun `로고가 없으면 자리를 잡지 않는다`() {
        val spot = LogoPlacement.resolve(LogoPlacement.SPOT_TOP_RIGHT, hasLogo = false, hasBarcode = false)
        assertEquals(LogoPlacement.SPOT_NONE, spot)
    }

    @Test
    fun `QR 과 겹치면 로고가 오른쪽 위로 비켜 준다`() {
        val spot = LogoPlacement.resolve(LogoPlacement.SPOT_BOTTOM_RIGHT, hasLogo = true, hasBarcode = true)
        assertEquals(LogoPlacement.SPOT_TOP_RIGHT, spot)
    }

    @Test
    fun `QR 이 없으면 오른쪽 아래에 그대로 둔다`() {
        val spot = LogoPlacement.resolve(LogoPlacement.SPOT_BOTTOM_RIGHT, hasLogo = true, hasBarcode = false)
        assertEquals(LogoPlacement.SPOT_BOTTOM_RIGHT, spot)
    }

    @Test
    fun `흰 바탕은 배경으로 보고 색이 든 점은 남긴다`() {
        assertTrue(LogoTrim.isBackground(255, 255, 255))
        assertTrue(LogoTrim.isBackground(240, 238, 241))
        assertFalse(LogoTrim.isBackground(27, 94, 142))
        assertFalse(LogoTrim.isBackground(120, 120, 120))
    }

    @Test
    fun `밝아도 색이 치우친 점은 남긴다`() {
        // 세 값이 모두 밝기 기준을 넘지만 노란 기운이 남아 있어 배경이 아니다.
        assertFalse(LogoTrim.isBackground(255, 250, 236))
        // 같은 정도로 밝고 색이 고르면 배경이다.
        assertTrue(LogoTrim.isBackground(250, 248, 247))
    }
}
