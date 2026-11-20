package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CardTemplatesTest {

    @Test
    fun `템플릿 id 는 겹치지 않는다`() {
        val ids = CardTemplates.ALL.map { it.id }
        assertEquals(ids.size, ids.distinct().size)
    }

    @Test
    fun `기본 템플릿이 목록에 있다`() {
        assertNotNull(CardTemplates.ALL.firstOrNull { it.id == CardTemplates.DEFAULT_ID })
    }

    @Test
    fun `배치 방식은 모두 한 번씩 쓰인다`() {
        val layouts = CardTemplates.ALL.map { it.layout }
        assertEquals(CardTemplate.Layout.values().size, layouts.distinct().size)
    }

    @Test
    fun `모르는 id 는 첫 번째 템플릿으로 떨어진다`() {
        assertEquals(CardTemplates.ALL.first(), CardTemplates.byId("무엇이든"))
    }

    @Test
    fun `모든 템플릿에 이름과 강조색이 있다`() {
        CardTemplates.ALL.forEach { template ->
            assertTrue(template.title.isNotBlank())
            // 색은 불투명해야 한다. 알파가 0 이면 아무것도 보이지 않는다.
            assertTrue((template.accent.toLong() and 0xFF000000L) != 0L)
        }
    }

    @Test
    fun `그림 크기는 명함 비율을 따른다`() {
        val ratio = CardTemplates.RENDER_WIDTH.toFloat() / CardTemplates.RENDER_HEIGHT
        assertEquals(CardCrop.CARD_ASPECT.toDouble(), ratio.toDouble(), 0.01)
    }

    @Test
    fun `강조색 선택지는 겹치지 않는다`() {
        assertEquals(CardTemplates.ACCENTS.size, CardTemplates.ACCENTS.distinct().size)
        assertTrue(CardTemplates.ACCENTS.isNotEmpty())
    }
}
