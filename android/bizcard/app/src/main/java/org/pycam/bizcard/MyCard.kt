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
    val accentColor: Int = 0,
    /**
     * true 면 템플릿으로 그리지 않고 가지고 있는 명함 사진을 그대로 쓴다.
     * 스캔 기록에서 고른 명함이나 새로 찍은 사진이 여기에 해당한다.
     */
    val usePhoto: Boolean = false,
    /** QR 에 담을 내용. [BarcodeContent] 의 MODE_* 값. */
    val barcodeMode: String = BarcodeContent.MODE_NONE,
    /** 링크 모드에서 직접 적은 주소. 비어 있으면 홈페이지 항목을 쓴다. */
    val barcodeText: String = "",
    /** 회사 로고를 넣을 자리. [LogoPlacement] 의 SPOT_* 값. */
    val logoSpot: String = LogoPlacement.SPOT_NONE,
    /** 로고 크기. 명함 가로 길이에 대한 비율이다. */
    val logoScale: Float = LogoPlacement.DEFAULT_SCALE
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

    /**
     * QR 에 담을 내용. 담을 것이 없거나 너무 길어서 명함 크기로는 읽히지 않으면 null.
     */
    fun barcodePayload(): String? =
        BarcodeContent.payload(this)?.takeIf { it.isNotBlank() && !BarcodeContent.isTooLong(it) }

    /** 로고를 실제로 그릴 자리. QR 과 겹치면 비켜 준다. */
    fun logoSpotFor(hasLogo: Boolean): String =
        LogoPlacement.resolve(logoSpot, hasLogo, barcodePayload() != null)

    /** vCard 로 보낼 수 있는지. 적어도 한 항목은 채워져 있어야 한다. */
    fun canSendVCard(): Boolean = !isEmpty

    /**
     * 명함 그림으로 보낼 수 있는지. 템플릿 모드는 항상 그릴 수 있지만
     * 사진 모드는 고른 사진이 있어야 한다.
     */
    fun canSendImage(hasPhoto: Boolean): Boolean = if (usePhoto) hasPhoto else true

    /** 저장할 내용이 있는지. 사진만 골라 둔 경우도 저장할 가치가 있다. */
    fun canSave(hasPhoto: Boolean): Boolean = !isEmpty || (usePhoto && hasPhoto)

    /** 스캔해 둔 명함에서 내 명함 항목을 가져온다. 이미 채워 둔 값은 건드리지 않는다. */
    fun fillFrom(card: BizCard): MyCard = copy(
        name = name.ifBlank { card.name },
        company = company.ifBlank { card.company },
        department = department.ifBlank { card.department },
        title = title.ifBlank { card.title },
        mobile = mobile.ifBlank { card.mobile },
        phone = phone.ifBlank { card.phone },
        fax = fax.ifBlank { card.fax },
        email = email.ifBlank { card.email },
        website = website.ifBlank { card.website },
        address = address.ifBlank { card.address }
    )
}
