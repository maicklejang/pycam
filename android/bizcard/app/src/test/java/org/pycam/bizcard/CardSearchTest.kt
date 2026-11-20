package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CardSearchTest {

    private val hong = BizCard(
        name = "홍길동",
        company = "㈜파이캠소프트",
        department = "연구개발본부",
        title = "책임연구원",
        mobile = "010-1234-5678",
        email = "gildong.hong@pycam.co.kr",
        address = "서울특별시 강남구 테헤란로 152"
    )
    private val jane = BizCard(
        name = "Jane A. Miller",
        company = "ACME Robotics Inc.",
        title = "Senior Software Engineer",
        mobile = "+821098765432",
        email = "jane.miller@acme-robotics.com"
    )
    private val park = BizCard(
        name = "박영희",
        company = "주식회사 다온",
        mobile = "010-1111-2222",
        rawText = "박영희 대표이사\n다온 빌딩 3층"
    )
    private val cards = listOf(hong, jane, park)

    @Test
    fun `빈 검색어는 전체를 돌려준다`() {
        assertEquals(cards, CardSearch.filter(cards, "   "))
    }

    @Test
    fun `이름으로 찾는다`() {
        assertEquals(listOf(hong), CardSearch.filter(cards, "홍길동"))
    }

    @Test
    fun `회사 이름 일부로 찾는다`() {
        assertEquals(listOf(hong), CardSearch.filter(cards, "파이캠"))
        assertEquals(listOf(jane), CardSearch.filter(cards, "robotics"))
    }

    @Test
    fun `대소문자를 가리지 않는다`() {
        assertEquals(listOf(jane), CardSearch.filter(cards, "ACME"))
        assertEquals(listOf(jane), CardSearch.filter(cards, "acme"))
    }

    @Test
    fun `구분자 없이 번호로 찾는다`() {
        assertEquals(listOf(hong), CardSearch.filter(cards, "01012345678"))
        assertEquals(listOf(hong), CardSearch.filter(cards, "12345678"))
    }

    @Test
    fun `구분자가 있는 그대로도 찾는다`() {
        assertEquals(listOf(park), CardSearch.filter(cards, "010-1111-2222"))
    }

    @Test
    fun `초성으로 찾는다`() {
        assertEquals(listOf(hong), CardSearch.filter(cards, "ㅎㄱㄷ"))
        assertEquals(listOf(park), CardSearch.filter(cards, "ㅂㅇㅎ"))
    }

    @Test
    fun `여러 낱말은 모두 만족해야 한다`() {
        assertEquals(listOf(hong), CardSearch.filter(cards, "홍길동 파이캠"))
        assertTrue(CardSearch.filter(cards, "홍길동 다온").isEmpty())
    }

    @Test
    fun `이메일과 주소로도 찾는다`() {
        assertEquals(listOf(hong), CardSearch.filter(cards, "gildong.hong"))
        assertEquals(listOf(hong), CardSearch.filter(cards, "테헤란로"))
    }

    @Test
    fun `인식 원문에서도 찾는다`() {
        assertEquals(listOf(park), CardSearch.filter(cards, "대표이사"))
    }

    @Test
    fun `없는 낱말은 결과가 비어 있다`() {
        assertTrue(CardSearch.filter(cards, "존재하지않는회사").isEmpty())
    }

    @Test
    fun `matches 는 개별 카드를 판정한다`() {
        assertTrue(CardSearch.matches(hong, "연구개발"))
        assertFalse(CardSearch.matches(hong, "robotics"))
    }

    @Test
    fun `초성 변환은 한글만 바꾼다`() {
        assertEquals("ㅎㄱㄷ acme 123", CardSearch.chosungOf("홍길동 acme 123").replace(" ", " "))
    }
}
