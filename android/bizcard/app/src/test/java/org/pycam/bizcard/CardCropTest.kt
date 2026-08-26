package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.pycam.bizcard.CardCrop.Box
import org.junit.Test

class CardCropTest {

    private fun box(left: Int, top: Int, right: Int, bottom: Int) = Box(left, top, right, bottom)

    /** 4000x3000 사진 한가운데 놓인 명함 위의 글자들. */
    private fun cardTextBoxes() = listOf(
        box(1200, 1100, 2200, 1180),
        box(1200, 1250, 2600, 1330),
        box(1200, 1400, 2000, 1480),
        box(1200, 1550, 2800, 1630),
        box(1200, 1700, 2400, 1780)
    )

    @Test
    fun `글자 영역을 감싸는 명함 영역을 찾는다`() {
        val crop = CardCrop.detect(cardTextBoxes(), 4000, 3000)
        assertNotNull(crop)
        crop!!

        // 모든 글자를 품어야 한다.
        assertTrue("$crop", crop.left <= 1200 && crop.top <= 1100)
        assertTrue("$crop", crop.right >= 2800 && crop.bottom >= 1780)
        // 원본보다 확실히 작아야 한다.
        assertTrue("$crop", crop.area < 4000L * 3000L / 2)
    }

    @Test
    fun `잘라낸 영역은 이미지 밖으로 나가지 않는다`() {
        val crop = CardCrop.detect(cardTextBoxes(), 4000, 3000)!!
        assertTrue("$crop", crop.left >= 0 && crop.top >= 0)
        assertTrue("$crop", crop.right <= 4000 && crop.bottom <= 3000)
    }

    @Test
    fun `가로로 짧은 영역은 명함 비율에 가깝게 넓힌다`() {
        val narrow = listOf(
            box(1800, 1200, 2200, 1280),
            box(1800, 1350, 2200, 1430),
            box(1800, 1500, 2200, 1580),
            box(1800, 1650, 2200, 1730),
            box(1800, 1800, 2200, 1880)
        )
        val crop = CardCrop.detect(narrow, 4000, 3000)!!
        val aspect = crop.width.toFloat() / crop.height
        assertTrue("aspect=$aspect box=$crop", aspect > 1.0f)
        assertTrue("aspect=$aspect box=$crop", aspect <= CardCrop.CARD_ASPECT + 0.05f)
    }

    @Test
    fun `배경에서 잘못 잡힌 글자 하나는 무시한다`() {
        val withOutlier = cardTextBoxes() + box(20, 30, 200, 90)
        val crop = CardCrop.detect(withOutlier, 4000, 3000)!!
        assertTrue("이상치를 품으면 안 된다: $crop", crop.left > 200)
    }

    @Test
    fun `글자가 사진 전체에 퍼져 있으면 자르지 않는다`() {
        val fullFrame = listOf(
            box(20, 20, 3980, 200),
            box(20, 800, 3980, 980),
            box(20, 1600, 3980, 1780),
            box(20, 2400, 3980, 2580),
            box(20, 2700, 3980, 2980)
        )
        assertNull(CardCrop.detect(fullFrame, 4000, 3000))
    }

    @Test
    fun `글자가 없으면 자르지 않는다`() {
        assertNull(CardCrop.detect(emptyList(), 4000, 3000))
    }

    @Test
    fun `이미지 크기를 모르면 자르지 않는다`() {
        assertNull(CardCrop.detect(cardTextBoxes(), 0, 0))
    }

    @Test
    fun `아주 작은 얼룩 하나는 명함으로 보지 않는다`() {
        val speck = listOf(box(2000, 1500, 2040, 1520))
        assertNull(CardCrop.detect(speck, 4000, 3000))
    }

    @Test
    fun `Box 는 너비와 높이를 계산한다`() {
        val b = box(10, 20, 110, 70)
        assertEquals(100, b.width)
        assertEquals(50, b.height)
        assertEquals(5000L, b.area)
    }
}
