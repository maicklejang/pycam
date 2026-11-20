package org.pycam.bizcard

/**
 * 저장된 명함 목록 검색.
 *
 * 이름·회사·부서·직함·번호·이메일·주소·메모는 물론 인식 원문까지 훑는다.
 * 숫자만 입력하면 번호에서 구분자를 무시하고 찾고, 초성만 입력하면 초성으로 찾는다.
 * ("ㅎㄱㄷ" -> "홍길동")
 */
object CardSearch {

    private val CHOSUNG = charArrayOf(
        'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
        'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
    )

    private const val HANGUL_START = 0xAC00
    private const val HANGUL_END = 0xD7A3
    private const val SYLLABLES_PER_CHOSUNG = 588

    fun filter(cards: List<BizCard>, query: String): List<BizCard> {
        val tokens = tokenize(query)
        if (tokens.isEmpty()) return cards
        return cards.filter { matchesTokens(it, tokens) }
    }

    fun matches(card: BizCard, query: String): Boolean {
        val tokens = tokenize(query)
        return tokens.isEmpty() || matchesTokens(card, tokens)
    }

    private fun tokenize(query: String): List<String> =
        query.trim().lowercase().split(' ', '\t', '\n').filter { it.isNotBlank() }

    /** 공백으로 나눈 토큰은 모두 만족해야 한다. */
    private fun matchesTokens(card: BizCard, tokens: List<String>): Boolean {
        val text = textOf(card)
        val digits = digitsOf(card)
        val chosung = chosungOf(text)
        return tokens.all { token ->
            when {
                text.contains(token) -> true
                token.all { it.isDigit() } && digits.contains(token) -> true
                isChosungOnly(token) && chosung.contains(token) -> true
                else -> false
            }
        }
    }

    private fun textOf(card: BizCard): String = listOf(
        card.name, card.company, card.title, card.department,
        card.mobile, card.phone, card.fax,
        card.email, card.website, card.address, card.note, card.rawText
    ).filter { it.isNotBlank() }.joinToString("\n").lowercase()

    /** 010-1234-5678 을 "01012345678" 처럼 만들어 구분자와 무관하게 찾는다. */
    private fun digitsOf(card: BizCard): String = listOf(card.mobile, card.phone, card.fax)
        .filter { it.isNotBlank() }
        .joinToString(" ") { value -> value.filter { it.isDigit() } }

    private fun isChosungOnly(token: String): Boolean =
        token.isNotEmpty() && token.all { it in CHOSUNG }

    /** 한글 음절은 초성으로 바꾸고, 나머지 문자는 그대로 남긴다. */
    fun chosungOf(text: String): String = buildString(text.length) {
        for (char in text) {
            val code = char.code
            if (code in HANGUL_START..HANGUL_END) {
                append(CHOSUNG[(code - HANGUL_START) / SYLLABLES_PER_CHOSUNG])
            } else {
                append(char)
            }
        }
    }
}
