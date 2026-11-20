package org.pycam.bizcard

/**
 * 사용자가 직접 만든 자기 명함. 템플릿과 강조색을 함께 들고 있어서 그림으로 그려낼 수 있다.
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라 JVM 단위 테스트로 검증한다.
 */
data class MyCard(
    val name: String = "",
    val company: String = "",
    val department: String = "",
    val title: String = "",
    val tagline: String = "",
    val mobile: String = "",
    val phone: String = "",
    val fax: String = "",
    val email: String = "",
    val website: String = "",
    val address: String = "",
    val templateId: String = CardTemplates.DEFAULT_ID,
    /** 템플릿의 강조색. 0 이면 템플릿 기본색을 쓴다. */
    val accentColor: Int = 0
) {
    val isEmpty: Boolean
        get() = listOf(name, company, mobile, phone, email).all { it.isBlank() }

    val displayName: String
        get() = name.ifBlank { company }.ifBlank { "내 명함" }

    /** "영업팀 · 팀장" 처럼 부서와 직함을 묶은 한 줄. */
    val roleLine: String
        get() = listOf(department, title).filter { it.isNotBlank() }.joinToString(" · ")

    val template: CardTemplate
        get() = CardTemplates.byId(templateId)

    /** 실제로 그릴 때 쓸 강조색. */
    fun resolvedAccent(): Int = if (accentColor != 0) accentColor else template.accent

    /** 명함 아래쪽에 줄줄이 적을 연락처 항목. 라벨과 값의 쌍이다. */
    fun contactLines(): List<Pair<String, String>> = buildList {
        if (mobile.isNotBlank()) add("M" to mobile)
        if (phone.isNotBlank()) add("T" to phone)
        if (fax.isNotBlank()) add("F" to fax)
        if (email.isNotBlank()) add("E" to email)
        if (website.isNotBlank()) add("W" to website)
        if (address.isNotBlank()) add("A" to address)
    }

    /** 주소록 저장·공유에 쓰도록 스캔 결과와 같은 모델로 바꾼다. */
    fun toBizCard(): BizCard = BizCard(
        name = name,
        company = company,
        title = title,
        department = department,
        mobile = mobile,
        phone = phone,
        fax = fax,
        email = email,
        website = website,
        address = address,
        note = tagline
    )

    fun toVCard(): String = toBizCard().toVCard()
}
