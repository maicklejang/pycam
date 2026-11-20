package org.pycam.bizcard

/**
 * OCR 로 읽어낸 명함 텍스트에서 주소록 항목을 추출한다.
 *
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이므로 JVM 단위 테스트로 검증할 수 있다.
 */
object BizCardParser {

    // ------------------------------------------------------------------ 정규식

    private val EMAIL = Regex("""[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}""")

    private val URL = Regex(
        """(?:https?://|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+""" +
            """|(?<![@\w.])[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.""" +
            """(?:com|net|org|co\.kr|or\.kr|go\.kr|re\.kr|ac\.kr|kr|io|dev|app|ai|biz|info|me)""" +
            """(?:/[^\s]*)?(?![\w.@])"""
    )

    /** 국내/국제 전화번호. 구분자는 -, ., 공백, 괄호를 허용한다. */
    private val PHONE = Regex(
        """(?:\+?\d{1,3}[\s.\-]?)?(?:\(0?\d{1,4}\)|0?\d{1,4})[\s.\-]\d{3,4}[\s.\-]\d{4}""" +
            """|\+?\d{2,3}[\s.\-]?\d{1,2}[\s.\-]\d{3,4}[\s.\-]\d{4}""" +
            """|01\d{8,9}""" +
            """|\d{4}[\s.\-]\d{4}"""
    )

    private val POSTAL = Regex("""\(?\b\d{5}\b\)?|\b\d{3}-\d{3}\b""")

    // ------------------------------------------------------------------ 사전

    private val MOBILE_LABELS = listOf(
        "휴대폰", "휴대전화", "핸드폰", "모바일", "셀룰러", "mobile", "cell", "hp", "h.p", "m.", "m ", "c.p", "cp"
    )
    private val FAX_LABELS = listOf("팩스", "fax", "f.", "f ")
    private val TEL_LABELS = listOf("전화", "대표번호", "사무실", "tel", "phone", "t.", "office", "direct", "d.")

    private val MOBILE_PREFIXES = listOf("010", "011", "016", "017", "018", "019")

    private val COMPANY_KEYWORDS = listOf(
        "주식회사", "(주)", "㈜", "유한회사", "(유)", "합자회사", "재단법인", "사단법인", "법인",
        "그룹", "홀딩스", "컴퍼니", "코퍼레이션", "산업", "전자", "건설", "물산", "상사", "테크",
        "연구소", "연구원", "대학교", "대학", "병원", "은행", "협회", "공사", "공단", "센터",
        "inc", "inc.", "corp", "corp.", "corporation", "co.", "co.,", "ltd", "ltd.", "llc", "l.l.c",
        "company", "group", "holdings", "technologies", "technology", "labs", "laboratory",
        "institute", "university", "systems", "solutions", "partners", "studio", "agency", "gmbh"
    )

    private val TITLE_KEYWORDS = listOf(
        "회장", "부회장", "사장", "부사장", "대표이사", "대표", "전무", "상무", "이사", "감사",
        "본부장", "실장", "센터장", "소장", "공장장", "지점장", "점장", "국장", "부장", "차장",
        "과장", "팀장", "파트장", "대리", "주임", "사원", "선임", "책임", "수석", "연구원", "교수",
        "박사", "변호사", "회계사", "세무사", "간호사", "약사", "기사", "매니저", "컨설턴트", "디자이너", "개발자",
        "ceo", "cto", "cfo", "coo", "cio", "cmo", "president", "vice president", "vp", "director",
        "head of", "chief", "manager", "supervisor", "principal", "senior", "lead", "engineer",
        "developer", "designer", "researcher", "consultant", "analyst", "specialist", "associate",
        "assistant", "officer", "founder", "partner", "professor", "attorney", "architect"
    )

    private val DEPARTMENT_SUFFIXES = listOf(
        "팀", "부", "실", "본부", "그룹", "사업부", "사업본부", "센터", "연구소", "지사", "지점", "파트", "국", "과"
    )
    private val DEPARTMENT_KEYWORDS = listOf(
        "division", "department", "dept", "team", "unit", "office of", "group"
    )

    private val ADDRESS_KEYWORDS = listOf(
        "특별시", "광역시", "특별자치시", "특별자치도", "도 ", "시 ", "군 ", "구 ", "읍 ", "면 ", "동 ",
        "로 ", "길 ", "번지", "빌딩", "타워", "층", "호실", "아파트", "단지", "우편번호",
        "street", "st.", "road", "rd.", "avenue", "ave", "boulevard", "blvd", "suite", "floor",
        "building", "tower", "korea", "seoul", "gyeonggi", "busan"
    )
    private val ADDRESS_LABELS = listOf("주소", "address", "addr", "소재지", "a.")

    private val KOREAN_NAME = Regex("""^[가-힣]{2,5}$""")
    private val LATIN_NAME = Regex("""^[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'.\-]+){1,3}$""")
    private val HANGUL = Regex("""[가-힣]""")

    // ------------------------------------------------------------------ 진입점

    /** ML Kit 이 돌려준 여러 줄 텍스트를 파싱한다. */
    fun parse(rawText: String): BizCard = parseLines(rawText.split('\n'))

    fun parseLines(rawLines: List<String>): BizCard {
        val lines = rawLines
            .map { it.replace('\u00A0', ' ').replace('\u3000', ' ').trim() }
            .filter { it.isNotEmpty() }

        val emails = LinkedHashSet<String>()
        val websites = LinkedHashSet<String>()
        val mobiles = LinkedHashSet<String>()
        val tels = LinkedHashSet<String>()
        val faxes = LinkedHashSet<String>()
        val addressParts = ArrayList<String>()
        val leftovers = ArrayList<String>()

        for (line in lines) {
            val lower = line.lowercase()
            var consumed = false

            EMAIL.findAll(line).forEach { emails += it.value.trimEnd('.', ',', ';'); consumed = true }

            val phones = PHONE.findAll(line)
                .map { normalizePhone(it.value) }
                .filter { isPlausiblePhone(it) }
                .toList()
            if (phones.isNotEmpty()) {
                consumed = true
                for ((index, phone) in phones.withIndex()) {
                    when (classifyPhone(line, lower, phone, index)) {
                        PhoneKind.MOBILE -> mobiles += phone
                        PhoneKind.FAX -> faxes += phone
                        PhoneKind.TEL -> tels += phone
                    }
                }
            }

            // URL 은 이메일 도메인과 겹치므로 이메일을 지운 뒤에 찾는다.
            val withoutEmail = EMAIL.replace(line, " ")
            URL.findAll(withoutEmail).forEach { match ->
                val url = match.value.trimEnd('.', ',', ';', ')')
                if (url.length >= 4 && !url.contains('@')) {
                    websites += url
                    consumed = true
                }
            }

            if (looksLikeAddress(line, lower)) {
                addressParts += stripLabel(line, ADDRESS_LABELS)
                consumed = true
            }

            if (!consumed) {
                val remainder = stripNoise(line)
                if (remainder.isNotEmpty()) leftovers += remainder
            }
        }

        val company = leftovers.firstOrNull { isCompany(it) }
        val title = leftovers.firstOrNull { it != company && isTitle(it) }
        val department = leftovers.firstOrNull { it != company && it != title && isDepartment(it) }
        val name = pickName(leftovers, company, title, department)

        val used = setOfNotNull(company, title, department, name)
        val notes = leftovers.filterNot { it in used }

        return BizCard(
            name = name.orEmpty(),
            company = company?.let { cleanupCompany(it) }.orEmpty(),
            title = title?.let { extractTitle(it) }.orEmpty(),
            department = department.orEmpty(),
            mobile = mobiles.firstOrNull().orEmpty(),
            phone = tels.firstOrNull().orEmpty(),
            fax = faxes.firstOrNull().orEmpty(),
            email = emails.firstOrNull().orEmpty(),
            website = websites.firstOrNull().orEmpty(),
            address = addressParts.joinToString(" ").trim(),
            note = notes.joinToString("\n"),
            rawText = lines.joinToString("\n")
        )
    }

    // ------------------------------------------------------------------ 전화번호

    private enum class PhoneKind { MOBILE, TEL, FAX }

    private fun classifyPhone(line: String, lower: String, phone: String, index: Int): PhoneKind {
        val digits = phone.filter { it.isDigit() }
        val local = toLocalDigits(digits)

        // 한 줄에 여러 번호가 있으면 라벨이 각 번호 앞에 붙어 있는 경우가 많다.
        val segment = segmentFor(lower, index)
        if (containsLabel(segment, FAX_LABELS)) return PhoneKind.FAX
        if (containsLabel(segment, MOBILE_LABELS)) return PhoneKind.MOBILE
        if (MOBILE_PREFIXES.any { local.startsWith(it) }) return PhoneKind.MOBILE
        if (containsLabel(lower, FAX_LABELS) && !containsLabel(segment, TEL_LABELS)) return PhoneKind.FAX
        if (containsLabel(lower, MOBILE_LABELS) && !containsLabel(segment, TEL_LABELS)) return PhoneKind.MOBILE
        return PhoneKind.TEL
    }

    /** 라벨 판정을 위해 index 번째 번호 앞쪽 구간을 잘라낸다. */
    private fun segmentFor(lower: String, index: Int): String {
        val matches = PHONE.findAll(lower).toList()
        if (index >= matches.size) return lower
        val start = if (index == 0) 0 else matches[index - 1].range.last + 1
        return lower.substring(start, matches[index].range.first.coerceAtLeast(start))
    }

    private fun containsLabel(text: String, labels: List<String>): Boolean =
        labels.any { text.contains(it) }

    /** +82 10 1234 5678 -> 01012345678 처럼 국내 표기로 되돌린다. */
    private fun toLocalDigits(digits: String): String = when {
        digits.startsWith("82") && digits.length >= 11 -> "0" + digits.removePrefix("82")
        else -> digits
    }

    private fun normalizePhone(raw: String): String {
        val trimmed = raw.trim().trim('.', ',', ';', '(', ')')
        val plus = trimmed.startsWith("+")
        val digits = trimmed.filter { it.isDigit() }
        if (plus) return "+" + digits
        return formatKorean(digits)
    }

    private fun formatKorean(digits: String): String = when {
        digits.startsWith("02") && digits.length == 9 ->
            "${digits.substring(0, 2)}-${digits.substring(2, 5)}-${digits.substring(5)}"
        digits.startsWith("02") && digits.length == 10 ->
            "${digits.substring(0, 2)}-${digits.substring(2, 6)}-${digits.substring(6)}"
        digits.length == 10 && digits.startsWith("0") ->
            "${digits.substring(0, 3)}-${digits.substring(3, 6)}-${digits.substring(6)}"
        digits.length == 11 && digits.startsWith("0") ->
            "${digits.substring(0, 3)}-${digits.substring(3, 7)}-${digits.substring(7)}"
        digits.length == 8 -> "${digits.substring(0, 4)}-${digits.substring(4)}"
        else -> digits
    }

    private fun isPlausiblePhone(phone: String): Boolean {
        val digits = phone.filter { it.isDigit() }
        return digits.length in 8..15
    }

    // ------------------------------------------------------------------ 줄 분류

    private fun looksLikeAddress(line: String, lower: String): Boolean {
        if (ADDRESS_LABELS.any { lower.startsWith(it) }) return true
        val padded = "$line "
        val hits = ADDRESS_KEYWORDS.count { padded.contains(it, ignoreCase = true) }
        val hasPostal = POSTAL.containsMatchIn(line)
        return hits >= 2 || (hits >= 1 && hasPostal) || (hits >= 1 && line.length >= 15)
    }

    private fun isCompany(line: String): Boolean {
        val lower = line.lowercase()
        return COMPANY_KEYWORDS.any { keyword ->
            if (keyword.first().isLetter() && keyword.all { it.isLetterOrDigit() || it == '.' || it == ',' }) {
                Regex("""(^|[^A-Za-z가-힣])${Regex.escape(keyword)}($|[^A-Za-z])""").containsMatchIn(lower)
            } else {
                lower.contains(keyword)
            }
        }
    }

    private fun isTitle(line: String): Boolean {
        if (line.length > 40) return false
        val lower = line.lowercase()
        return TITLE_KEYWORDS.any { keyword ->
            if (HANGUL.containsMatchIn(keyword)) lower.contains(keyword)
            else Regex("""(^|[^a-z])${Regex.escape(keyword)}($|[^a-z])""").containsMatchIn(lower)
        }
    }

    private fun isDepartment(line: String): Boolean {
        if (line.length > 40) return false
        val lower = line.lowercase()
        if (DEPARTMENT_KEYWORDS.any { lower.contains(it) }) return true
        val head = line.substringBefore(' ')
        return DEPARTMENT_SUFFIXES.any { head.endsWith(it) && head.length > it.length }
    }

    private fun pickName(
        leftovers: List<String>,
        company: String?,
        title: String?,
        department: String?
    ): String? {
        val candidates = leftovers.filter { it != company && it != department }

        // 1) "홍길동 대표이사" 처럼 직함과 붙어 있는 줄에서 이름만 뽑아낸다.
        title?.let { titleLine ->
            extractNameFromTitleLine(titleLine)?.let { return it }
        }
        // 2) 순수한 이름 형태의 줄
        candidates.firstOrNull { it != title && KOREAN_NAME.matches(it) && !isTitle(it) }?.let { return it }
        candidates.firstOrNull { it != title && LATIN_NAME.matches(it) && !isCompany(it) && !isTitle(it) }
            ?.let { return it }
        // 3) 남은 줄 중 가장 짧고 짧은 단어로 이루어진 줄
        return candidates.firstOrNull { it != title && it.length <= 20 && !isCompany(it) }
    }

    private fun extractNameFromTitleLine(line: String): String? {
        val tokens = line.split(Regex("""[\s/|·,]+""")).filter { it.isNotBlank() }
        val nameToken = tokens.firstOrNull { KOREAN_NAME.matches(it) && !isTitle(it) }
        if (nameToken != null) return nameToken
        val latin = tokens.filter { it.matches(Regex("""^[A-Z][A-Za-z'\-]+$""")) && !isTitle(it) }
        if (latin.size >= 2) return latin.take(2).joinToString(" ")
        return null
    }

    /** "홍길동 대표이사" 처럼 이름이 섞인 줄에서 이름 토큰만 걷어낸다. */
    private fun extractTitle(line: String): String {
        val name = extractNameFromTitleLine(line) ?: return line
        val nameTokens = name.split(' ').toSet()
        val rest = line.split(Regex("""[\s/|·,]+"""))
            .filter { it.isNotBlank() && it !in nameTokens }
        return if (rest.isEmpty()) line else rest.joinToString(" ")
    }

    private fun cleanupCompany(line: String): String =
        line.replace(Regex("""\s{2,}"""), " ").trim()

    private fun stripLabel(line: String, labels: List<String>): String {
        var result = line
        for (label in labels) {
            val index = result.lowercase().indexOf(label)
            if (index in 0..3) {
                result = result.substring(index + label.length).trimStart(':', '.', ')', ' ', '|')
                break
            }
        }
        return result.trim()
    }

    /** 라벨만 남은 줄("TEL", "E-mail :" 등)은 버린다. */
    private fun stripNoise(line: String): String {
        val cleaned = line.trim().trim('|', '·', ':', '/', ' ')
        if (cleaned.length <= 1) return ""
        val lower = cleaned.lowercase()
        val labelOnly = (MOBILE_LABELS + FAX_LABELS + TEL_LABELS + ADDRESS_LABELS + listOf("e-mail", "email", "이메일", "web", "홈페이지"))
            .any { lower.trim(':', '.', ' ') == it.trim(':', '.', ' ') }
        return if (labelOnly) "" else cleaned
    }
}
