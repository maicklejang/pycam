package org.pycam.bizcard

/** 명함 한 장에서 추출한 주소록 항목. */
data class BizCard(
    val name: String = "",
    val company: String = "",
    val title: String = "",
    val department: String = "",
    val mobile: String = "",
    val phone: String = "",
    val fax: String = "",
    val email: String = "",
    val website: String = "",
    val address: String = "",
    val note: String = "",
    val rawText: String = "",
    /** 촬영한 명함 이미지 파일 이름(앱 내부 저장소 기준). */
    val imageName: String = "",
    /** 이미지가 이미 명함 영역만 남기고 잘린 상태인지. 두 번 잘리는 것을 막는다. */
    val cropped: Boolean = false,
    val savedAt: Long = 0L
) {
    val isEmpty: Boolean
        get() = listOf(name, company, mobile, phone, email).all { it.isBlank() }

    val displayName: String
        get() = when {
            name.isNotBlank() -> name
            company.isNotBlank() -> company
            email.isNotBlank() -> email.substringBefore('@')
            else -> "이름 없음"
        }

    val displaySubtitle: String
        get() = listOf(company, title, department)
            .filter { it.isNotBlank() }
            .joinToString(" · ")

    /** 표준 vCard 3.0 문자열. 연락처 앱 가져오기/공유에 사용한다. */
    fun toVCard(): String = buildString {
        append("BEGIN:VCARD\r\n")
        append("VERSION:3.0\r\n")
        append("N:").append(escape(name)).append(";;;;\r\n")
        append("FN:").append(escape(displayName)).append("\r\n")
        if (company.isNotBlank() || department.isNotBlank()) {
            append("ORG:").append(escape(company))
            if (department.isNotBlank()) append(';').append(escape(department))
            append("\r\n")
        }
        if (title.isNotBlank()) append("TITLE:").append(escape(title)).append("\r\n")
        if (mobile.isNotBlank()) append("TEL;TYPE=CELL:").append(mobile).append("\r\n")
        if (phone.isNotBlank()) append("TEL;TYPE=WORK,VOICE:").append(phone).append("\r\n")
        if (fax.isNotBlank()) append("TEL;TYPE=WORK,FAX:").append(fax).append("\r\n")
        if (email.isNotBlank()) append("EMAIL;TYPE=WORK:").append(email).append("\r\n")
        if (website.isNotBlank()) append("URL:").append(website).append("\r\n")
        if (address.isNotBlank()) append("ADR;TYPE=WORK:;;").append(escape(address)).append(";;;;\r\n")
        if (note.isNotBlank()) append("NOTE:").append(escape(note)).append("\r\n")
        append("END:VCARD\r\n")
    }

    private fun escape(value: String): String = value
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
}
