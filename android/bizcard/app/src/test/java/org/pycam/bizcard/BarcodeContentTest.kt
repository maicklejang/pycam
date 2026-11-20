package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BarcodeContentTest {

    private val card = MyCard(
        name = "홍길동",
        company = "한빛상사",
        department = "영업팀",
        title = "팀장",
        mobile = "010-1234-5678",
        phone = "02-555-0000",
        email = "gil@hanbit.example",
        website = "hanbit.example",
        address = "서울특별시 중구 세종대로 110"
    )

    @Test
    fun `모르는 모드는 넣지 않기로 본다`() {
        assertEquals(BarcodeContent.MODE_NONE, BarcodeContent.normalizeMode("무엇"))
        assertEquals(BarcodeContent.MODE_CONTACT, BarcodeContent.normalizeMode("contact"))
    }

    @Test
    fun `넣지 않기면 담을 내용이 없다`() {
        assertNull(BarcodeContent.payload(card.copy(barcodeMode = BarcodeContent.MODE_NONE)))
    }

    @Test
    fun `연락처는 MECARD 로 담는다`() {
        val payload = BarcodeContent.payload(card.copy(barcodeMode = BarcodeContent.MODE_CONTACT))
        assertNotNull(payload)
        val value = payload!!
        assertTrue(value.startsWith("MECARD:"))
        assertTrue(value.endsWith(";;"))
        assertTrue(value.contains("N:홍길동;"))
        assertTrue(value.contains("ORG:한빛상사 영업팀 · 팀장;"))
        assertTrue(value.contains("TEL:01012345678;"))
        assertTrue(value.contains("TEL:025550000;"))
        assertTrue(value.contains("EMAIL:gil@hanbit.example;"))
        assertTrue(value.contains("URL:https\\://hanbit.example;"))
    }

    @Test
    fun `빈 항목은 MECARD 에 넣지 않는다`() {
        val payload = BarcodeContent.mecard(MyCard(name = "김하나", mobile = "01099998888"))
        assertEquals("MECARD:N:김하나;TEL:01099998888;;", payload)
    }

    @Test
    fun `담을 것이 하나도 없으면 null`() {
        assertNull(BarcodeContent.mecard(MyCard()))
    }

    @Test
    fun `뜻이 따로 있는 글자는 역슬래시로 감싼다`() {
        assertEquals("""a\;b""", BarcodeContent.escape("a;b"))
        assertEquals("""a\:b""", BarcodeContent.escape("a:b"))
        assertEquals("""a\,b""", BarcodeContent.escape("a,b"))
        assertEquals("""a\\b""", BarcodeContent.escape("""a\b"""))
        assertEquals("a b", BarcodeContent.escape("a\nb"))
    }

    @Test
    fun `MECARD 는 줄바꿈 때문에 깨지지 않는다`() {
        val payload = BarcodeContent.mecard(
            MyCard(name = "홍길동", address = "서울시 중구\n세종대로 110")
        )!!
        assertFalse(payload.contains("\n"))
    }

    @Test
    fun `전화번호는 숫자만 남긴다`() {
        assertEquals("01012345678", BarcodeContent.digitsOf("010-1234-5678"))
        assertEquals("+821012345678", BarcodeContent.digitsOf("+82 10-1234-5678"))
        assertEquals("", BarcodeContent.digitsOf("내선"))
        assertEquals("", BarcodeContent.digitsOf("   "))
    }

    @Test
    fun `주소에 http 를 붙여 연결되는 링크로 만든다`() {
        assertEquals("https://example.com", BarcodeContent.normalizeLink("example.com"))
        assertEquals("http://example.com", BarcodeContent.normalizeLink("http://example.com"))
        assertEquals("https://example.com/a", BarcodeContent.normalizeLink(" https://example.com/a "))
        assertNull(BarcodeContent.normalizeLink(""))
        assertNull(BarcodeContent.normalizeLink("회사 홈페이지"))
        assertNull(BarcodeContent.normalizeLink("그냥글자"))
    }

    @Test
    fun `링크 모드는 직접 적은 주소를 먼저 쓴다`() {
        val linked = card.copy(barcodeMode = BarcodeContent.MODE_LINK, barcodeText = "intro.example/me")
        assertEquals("https://intro.example/me", BarcodeContent.payload(linked))
    }

    @Test
    fun `직접 적은 주소가 없으면 홈페이지를 쓴다`() {
        val linked = card.copy(barcodeMode = BarcodeContent.MODE_LINK)
        assertEquals("https://hanbit.example", BarcodeContent.payload(linked))
    }

    @Test
    fun `링크로 쓸 수 없는 값이면 담을 내용이 없다`() {
        val linked = MyCard(name = "홍길동", barcodeMode = BarcodeContent.MODE_LINK)
        assertNull(BarcodeContent.payload(linked))
    }

    @Test
    fun `너무 긴 내용은 QR 로 만들지 않는다`() {
        assertFalse(BarcodeContent.isTooLong("짧은 내용"))
        // 한글은 한 자가 3바이트다. 글자 수가 아니라 바이트로 잰다.
        assertTrue(BarcodeContent.isTooLong("가".repeat(BarcodeContent.MAX_PAYLOAD / 3 + 1)))
        assertFalse(BarcodeContent.isTooLong("a".repeat(BarcodeContent.MAX_PAYLOAD)))
    }

    @Test
    fun `내용이 너무 길면 명함용 QR 을 내놓지 않는다`() {
        val long = card.copy(
            barcodeMode = BarcodeContent.MODE_CONTACT,
            address = "서울특별시 중구 세종대로 110 ".repeat(30),
            tagline = "오래 적은 소개 글 ".repeat(20)
        )
        assertNull(long.barcodePayload())
        // 모드 자체는 살아 있으므로 항목을 줄이면 다시 만들어진다.
        assertNotNull(BarcodeContent.payload(long))
    }

    @Test
    fun `보통 명함 한 장은 QR 한도 안에 들어간다`() {
        val payload = card.copy(barcodeMode = BarcodeContent.MODE_CONTACT).barcodePayload()
        assertNotNull(payload)
        assertFalse(BarcodeContent.isTooLong(payload!!))
    }

    // ------------------------------------------------------------------ 실제 QR 격자

    @Test
    fun `한글이 든 연락처 QR 도 명함에 넣을 만큼 촘촘하지 않다`() {
        val payload = card.copy(barcodeMode = BarcodeContent.MODE_CONTACT).barcodePayload()!!
        val modules = BarcodeEncoder.moduleCount(payload)
        assertNotNull(modules)
        // 1024px 폭 명함의 오른쪽 아래 칸은 약 190px 이다. 모듈이 69칸을 넘으면
        // 한 칸이 2.7px 아래로 떨어져 읽기 어려워진다.
        assertTrue("모듈 $modules 칸", modules!! <= 69)
    }

    @Test
    fun `QR 은 모듈이 정수 픽셀로 떨어지는 크기로 맞춘다`() {
        val payload = card.copy(barcodeMode = BarcodeContent.MODE_CONTACT).barcodePayload()!!
        val modules = BarcodeEncoder.moduleCount(payload)!!
        val side = modules + BarcodeEncoder.QUIET_ZONE * 2
        val fitted = BarcodeEncoder.fittedSize(payload, 190)
        assertNotNull(fitted)
        assertTrue(fitted!! <= 190)
        assertEquals(0, fitted % side)
    }

    @Test
    fun `격자를 담을 수 없는 크기면 만들지 않는다`() {
        assertNull(BarcodeEncoder.fittedSize("MECARD:N:홍길동;;", 10))
        assertNull(BarcodeEncoder.encode("", 200))
        assertNull(BarcodeEncoder.moduleCount(" "))
    }

    @Test
    fun `격자는 요청한 크기로 만들어진다`() {
        val matrix = BarcodeEncoder.encode("https://example.com", 200)
        assertNotNull(matrix)
        assertEquals(200, matrix!!.width)
        assertEquals(200, matrix.height)
    }
}
