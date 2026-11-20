package org.pycam.bizcard

/**
 * 내 명함 템플릿 한 개. 배치 방식과 기본 강조색만 들고 있고, 실제 그리기는
 * [CardRenderer] 가 담당한다. 안드로이드 API 에 의존하지 않는 순수 Kotlin 이다.
 */
data class CardTemplate(
    val id: String,
    val title: String,
    /** 배치 방식. 그리는 쪽에서 분기한다. */
    val layout: Layout,
    /** 기본 강조색 (ARGB). */
    val accent: Int,
    /** 배경색 (ARGB). */
    val background: Int = 0xFFFFFFFF.toInt(),
    /** 본문 글자색 (ARGB). */
    val foreground: Int = 0xFF1A1A1A.toInt()
) {
    enum class Layout {
        /** 왼쪽에 세로 색 띠, 오른쪽에 글자. */
        SIDE_BAR,

        /** 위쪽에 색 띠, 아래에 글자. */
        TOP_BAND,

        /** 가운데 정렬, 이름 아래 가로선. */
        CENTERED,

        /** 왼쪽 색 면에 이름, 오른쪽 흰 면에 연락처. */
        SPLIT,

        /** 색을 거의 쓰지 않는 담백한 배치. */
        MINIMAL,

        /** 배경 전체가 강조색이고 글자는 밝은색. */
        BOLD
    }
}

object CardTemplates {

    const val DEFAULT_ID = "sidebar"

    /** 강조색으로 고를 수 있는 색. 첫 번째가 템플릿 기본색 대신 쓰이는 일은 없다. */
    val ACCENTS: List<Int> = listOf(
        0xFF1B5E8E.toInt(), // 남청
        0xFF2E9E7C.toInt(), // 초록
        0xFF8E44AD.toInt(), // 자주
        0xFFC0392B.toInt(), // 붉은색
        0xFF2C3E50.toInt(), // 먹색
        0xFFD68910.toInt()  // 황토
    )

    val ALL: List<CardTemplate> = listOf(
        CardTemplate(
            id = DEFAULT_ID,
            title = "세로 띠",
            layout = CardTemplate.Layout.SIDE_BAR,
            accent = 0xFF1B5E8E.toInt()
        ),
        CardTemplate(
            id = "band",
            title = "가로 띠",
            layout = CardTemplate.Layout.TOP_BAND,
            accent = 0xFF2E9E7C.toInt()
        ),
        CardTemplate(
            id = "centered",
            title = "가운데 정렬",
            layout = CardTemplate.Layout.CENTERED,
            accent = 0xFF2C3E50.toInt()
        ),
        CardTemplate(
            id = "split",
            title = "좌우 분할",
            layout = CardTemplate.Layout.SPLIT,
            accent = 0xFF8E44AD.toInt()
        ),
        CardTemplate(
            id = "minimal",
            title = "담백하게",
            layout = CardTemplate.Layout.MINIMAL,
            accent = 0xFF555555.toInt()
        ),
        CardTemplate(
            id = "bold",
            title = "색 가득",
            layout = CardTemplate.Layout.BOLD,
            accent = 0xFFC0392B.toInt(),
            background = 0xFFC0392B.toInt(),
            foreground = 0xFFFFFFFF.toInt()
        )
    )

    fun byId(id: String): CardTemplate = ALL.firstOrNull { it.id == id } ?: ALL.first()

    /** 표준 명함 비율에 맞춘 그림 크기. 가로 85.6mm x 세로 54mm. */
    const val RENDER_WIDTH = 1024
    val RENDER_HEIGHT: Int = (RENDER_WIDTH / CardCrop.CARD_ASPECT).toInt()
}
