package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MyCardTest {

    @Test
    fun `이름이 없으면 회사 이름을 쓴다`() {
        assertEquals("파이캠", MyCard(company = "파이캠").displayName)
        assertEquals("홍길동", MyCard(name = "홍길동", company = "파이캠").displayName)
        assertEquals("내 명함", MyCard().displayName)
    }

    @Test
    fun `부서와 직함을 한 줄로 묶는다`() {
        assertEquals("영업팀 · 팀장", MyCard(department = "영업팀", title = "팀장").roleLine)
        assertEquals("팀장", MyCard(title = "팀장").roleLine)
        assertEquals("", MyCard().roleLine)
    }

    @Test
    fun `연락처 줄은 입력한 항목만 순서대로 나온다`() {
        val card = MyCard(
            mobile = "010-1234-5678",
            email = "hong@pycam.co.kr",
            website = "https://pycam.co.kr"
        )
        assertEquals(
            listOf("M" to "010-1234-5678", "E" to "hong@pycam.co.kr", "W" to "https://pycam.co.kr"),
            card.contactLines()
        )
    }

    @Test
    fun `연락처가 비어 있으면 줄이 없다`() {
        assertTrue(MyCard(name = "홍길동").contactLines().isEmpty())
    }

    @Test
    fun `강조색을 고르지 않으면 템플릿 기본색을 쓴다`() {
        val template = CardTemplates.byId("band")
        assertEquals(template.accent, MyCard(templateId = "band").resolvedAccent())
        assertEquals(0xFF123456.toInt(), MyCard(accentColor = 0xFF123456.toInt()).resolvedAccent())
    }

    @Test
    fun `이름이나 연락처가 하나라도 있으면 비어 있지 않다`() {
        assertTrue(MyCard().isEmpty)
        assertTrue(MyCard(website = "https://pycam.co.kr").isEmpty)
        assertFalse(MyCard(name = "홍길동").isEmpty)
        assertFalse(MyCard(mobile = "010-1234-5678").isEmpty)
    }

    @Test
    fun `주소록 모델로 바꿀 때 한 줄 소개는 메모로 옮긴다`() {
        val card = MyCard(
            name = "홍길동",
            company = "파이캠",
            department = "영업팀",
            title = "팀장",
            tagline = "카메라 소프트웨어",
            mobile = "010-1234-5678"
        )
        val converted = card.toBizCard()
        assertEquals("홍길동", converted.name)
        assertEquals("파이캠", converted.company)
        assertEquals("영업팀", converted.department)
        assertEquals("팀장", converted.title)
        assertEquals("카메라 소프트웨어", converted.note)
        assertEquals("010-1234-5678", converted.mobile)
    }

    @Test
    fun `vCard 로 내보낼 수 있다`() {
        val vcard = MyCard(name = "홍길동", company = "파이캠", mobile = "010-1234-5678").toVCard()
        assertTrue(vcard.startsWith("BEGIN:VCARD"))
        assertTrue(vcard.contains("FN:홍길동"))
        assertTrue(vcard.contains("ORG:파이캠"))
        assertTrue(vcard.contains("TEL;TYPE=CELL:010-1234-5678"))
        assertTrue(vcard.trimEnd().endsWith("END:VCARD"))
    }

    @Test
    fun `템플릿 id 가 잘못돼도 기본 템플릿으로 떨어진다`() {
        assertEquals(CardTemplates.ALL.first().id, MyCard(templateId = "없는템플릿").template.id)
    }
}
