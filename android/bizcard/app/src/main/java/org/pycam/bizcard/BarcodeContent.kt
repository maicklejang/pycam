package org.pycam.bizcard

/**
 * 내 명함에 넣을 QR 코드에 담을 내용을 만든다.
 *
 * 연락처는 vCard 대신 **MECARD** 형식으로 담는다. 담는 내용은 같지만 길이가 훨씬 짧아서
 * QR 칸이 덜 촘촘해지고, 그만큼 명함에 작게 넣어도 잘 읽힌다. 안드로이드·아이폰 카메라가
 * 모두 MECARD 를 알아보고 "연락처 추가" 를 띄운다.
 *
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라 JVM 단위 테스트로 검증한다.
 */
object BarcodeContent {

    /** QR 을 넣지 않는다. */
    const val MODE_NONE = "none"

    /** 연락처(MECARD). 찍으면 주소록에 바로 추가된다. */
    const val MODE_CONTACT = "contact"

    /** 링크. 홈페이지나 직접 적은 주소로 연결한다. */
    const val MODE_LINK = "link"

    val MODES: List<String> = listOf(MODE_NONE, MODE_CONTACT, MODE_LINK)

    /**
     * QR 한 장에 안전하게 담을 수 있는 크기(UTF-8 바이트). 한글 한 자가 3바이트라
     * 글자 수로 재면 어림이 맞지 않는다.
     *
     * 이 정도면 QR 격자가 69칸을 넘지 않아서, 명함 오른쪽 아래의 작은 칸에 넣어도
     * 휴대폰 카메라가 읽어낸다. 이보다 길면 칸이 너무 촘촘해진다.
     */
    const val MAX_PAYLOAD = 300

    fun normalizeMode(value: String): String = if (value in MODES) value else MODE_NONE

    /**
     * [card] 를 QR 에 담을 문자열로 바꾼다. 담을 내용이 없으면 null.
     */
    fun payload(card: MyCard): String? = when (normalizeMode(card.barcodeMode)) {
        MODE_CONTACT -> mecard(card)
        MODE_LINK -> link(card)
        else -> null
    }

    /** 길이 때문에 QR 로 만들기 어려운지. */
    fun isTooLong(payload: String): Boolean = payload.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD

    /**
     * MECARD 문자열. 값이 없는 항목은 아예 넣지 않는다.
     *
     * 예: `MECARD:N:홍길동;ORG:한빛상사;TEL:01012345678;EMAIL:gil@example.com;;`
     */
    fun mecard(card: MyCard): String? {
        val parts = ArrayList<String>()

        fun add(key: String, value: String) {
            if (value.isNotBlank()) parts += "$key:${escape(value)};"
        }

        add("N", card.name)
        add("ORG", listOf(card.company, card.roleLine).filter { it.isNotBlank() }.joinToString(" "))
        // 전화번호는 QR 로 거는 쪽이 많아 숫자만 남긴다. 사이에 든 붙임표는 기기마다 다루는 법이 달라진다.
        add("TEL", digitsOf(card.mobile))
        add("TEL", digitsOf(card.phone))
        add("EMAIL", card.email)
        add("URL", normalizeLink(card.website).orEmpty())
        add("ADR", card.address)
        add("NOTE", card.tagline)

        if (parts.isEmpty()) return null
        return "MECARD:" + parts.joinToString("") + ";"
    }

    /** 링크 모드에 쓸 주소. 직접 적은 값이 있으면 그것을, 없으면 홈페이지를 쓴다. */
    fun link(card: MyCard): String? =
        normalizeLink(card.barcodeText) ?: normalizeLink(card.website)

    /** `example.com` 처럼 적어도 `https://` 를 붙여 연결되는 주소로 만든다. 빈 값이면 null. */
    fun normalizeLink(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return null
        val lower = trimmed.lowercase()
        return when {
            lower.startsWith("http://") || lower.startsWith("https://") -> trimmed
            lower.startsWith("mailto:") || lower.startsWith("tel:") -> trimmed
            // 공백이 든 값은 주소가 아니라 그냥 글이다.
            trimmed.contains(' ') -> null
            !trimmed.contains('.') -> null
            else -> "https://$trimmed"
        }
    }

    /** 전화번호에서 숫자와 맨 앞의 +만 남긴다. */
    fun digitsOf(value: String): String {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return ""
        val digits = trimmed.filter { it.isDigit() }
        if (digits.isEmpty()) return ""
        return if (trimmed.startsWith("+")) "+$digits" else digits
    }

    /** MECARD 에서 뜻이 따로 있는 글자(`\ ; : ,`) 앞에 역슬래시를 붙인다. */
    fun escape(value: String): String {
        val builder = StringBuilder(value.length + 8)
        for (ch in value.trim()) {
            when (ch) {
                '\\', ';', ':', ',' -> builder.append('\\').append(ch)
                '\n', '\r' -> builder.append(' ')
                else -> builder.append(ch)
            }
        }
        return builder.toString()
    }
}
