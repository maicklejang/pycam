package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BizCardParserTest {

    @Test
    fun `한글 명함을 파싱한다`() {
        val card = BizCardParser.parse(
            """
            ㈜파이캠소프트
            연구개발본부
            홍길동 책임연구원
            서울특별시 강남구 테헤란로 152 강남파이낸스센터 21층
            T. 02-3456-7890  F. 02-3456-7891
            M. 010-1234-5678
            gildong.hong@pycam.co.kr
            www.pycam.co.kr
            """.trimIndent()
        )

        assertEquals("홍길동", card.name)
        assertEquals("㈜파이캠소프트", card.company)
        assertEquals("책임연구원", card.title)
        assertEquals("연구개발본부", card.department)
        assertEquals("010-1234-5678", card.mobile)
        assertEquals("02-3456-7890", card.phone)
        assertEquals("02-3456-7891", card.fax)
        assertEquals("gildong.hong@pycam.co.kr", card.email)
        assertEquals("www.pycam.co.kr", card.website)
        assertTrue(card.address, card.address.contains("테헤란로 152"))
    }

    @Test
    fun `영문 명함을 파싱한다`() {
        val card = BizCardParser.parse(
            """
            ACME Robotics Inc.
            Jane A. Miller
            Senior Software Engineer
            Platform Division
            Tel +82 2 555 0100
            Mobile +82 10 9876 5432
            jane.miller@acme-robotics.com
            https://acme-robotics.com
            21 Teheran-ro, Gangnam-gu, Seoul, Korea
            """.trimIndent()
        )

        assertEquals("Jane A. Miller", card.name)
        assertEquals("ACME Robotics Inc.", card.company)
        assertEquals("Platform Division", card.department)
        assertEquals("Senior Software Engineer", card.title)
        assertEquals("jane.miller@acme-robotics.com", card.email)
        assertEquals("https://acme-robotics.com", card.website)
        assertEquals("+821098765432", card.mobile)
        assertEquals("+8225550100", card.phone)
        assertTrue(card.address, card.address.contains("Gangnam-gu"))
    }

    @Test
    fun `라벨 없이 010 으로 시작하면 휴대폰으로 분류한다`() {
        val card = BizCardParser.parse("김철수\n010-2222-3333\n02-777-8888")
        assertEquals("김철수", card.name)
        assertEquals("010-2222-3333", card.mobile)
        assertEquals("02-777-8888", card.phone)
    }

    @Test
    fun `한 줄에 전화와 팩스가 함께 있어도 구분한다`() {
        val card = BizCardParser.parse("TEL 031-123-4567 / FAX 031-123-4568")
        assertEquals("031-123-4567", card.phone)
        assertEquals("031-123-4568", card.fax)
    }

    @Test
    fun `번호가 공백으로 구분되어도 정규화한다`() {
        val card = BizCardParser.parse("휴대전화 010 5555 6666")
        assertEquals("010-5555-6666", card.mobile)
    }

    @Test
    fun `이메일 도메인을 웹사이트로 오인하지 않는다`() {
        val card = BizCardParser.parse("hong@example.com")
        assertEquals("hong@example.com", card.email)
        assertEquals("", card.website)
    }

    @Test
    fun `이름과 직함이 한 줄에 있어도 분리한다`() {
        val card = BizCardParser.parse("주식회사 다온\n박영희 대표이사\n010-1111-2222")
        assertEquals("박영희", card.name)
        assertEquals("대표이사", card.title)
        assertEquals("주식회사 다온", card.company)
    }

    @Test
    fun `빈 입력은 비어있는 카드를 만든다`() {
        assertTrue(BizCardParser.parse("   \n\n  ").isEmpty)
    }

    @Test
    fun `우편번호가 있는 주소 줄을 인식한다`() {
        val card = BizCardParser.parse("(06236) 서울 강남구 테헤란로 152")
        assertTrue(card.address, card.address.contains("테헤란로"))
    }

    @Test
    fun `vCard 를 생성한다`() {
        val vcard = BizCard(
            name = "홍길동",
            company = "파이캠",
            title = "대표",
            mobile = "010-1234-5678",
            email = "a@b.com"
        ).toVCard()

        assertTrue(vcard.startsWith("BEGIN:VCARD"))
        assertTrue(vcard.trimEnd().endsWith("END:VCARD"))
        assertTrue(vcard.contains("FN:홍길동"))
        assertTrue(vcard.contains("TEL;TYPE=CELL:010-1234-5678"))
        assertTrue(vcard.contains("EMAIL;TYPE=WORK:a@b.com"))
    }
}
