package org.pycam.bizcard

/**
 * 명함에 얹는 그림(회사 로고)의 자리와, 사진에서 흰 배경을 지우는 기준.
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라 JVM 단위 테스트로 검증한다.
 */
object LogoPlacement {

    const val SPOT_NONE = "none"
    const val SPOT_TOP_RIGHT = "tr"
    const val SPOT_TOP_LEFT = "tl"
    const val SPOT_BOTTOM_RIGHT = "br"

    val SPOTS: List<String> = listOf(SPOT_NONE, SPOT_TOP_RIGHT, SPOT_TOP_LEFT, SPOT_BOTTOM_RIGHT)

    /** 로고 크기(명함 가로 길이에 대한 비율)로 고를 수 있는 범위. */
    const val MIN_SCALE = 0.10f
    const val MAX_SCALE = 0.40f
    const val DEFAULT_SCALE = 0.22f

    fun normalizeSpot(value: String): String = if (value in SPOTS) value else SPOT_NONE

    fun normalizeScale(value: Float): Float = when {
        value.isNaN() -> DEFAULT_SCALE
        value < MIN_SCALE -> MIN_SCALE
        value > MAX_SCALE -> MAX_SCALE
        else -> value
    }

    /**
     * 실제로 로고를 그릴 자리. QR 은 언제나 오른쪽 아래에 들어가므로, 로고를 거기에 두라고
     * 해도 QR 이 있으면 오른쪽 위로 비켜 준다. 로고가 없으면 [SPOT_NONE].
     */
    fun resolve(spot: String, hasLogo: Boolean, hasBarcode: Boolean): String {
        if (!hasLogo) return SPOT_NONE
        val wanted = normalizeSpot(spot)
        if (wanted == SPOT_NONE) return SPOT_NONE
        if (wanted == SPOT_BOTTOM_RIGHT && hasBarcode) return SPOT_TOP_RIGHT
        return wanted
    }
}

/** 로고 사진에서 흰 배경을 지울 때 쓰는 기준. */
object LogoTrim {

    /**
     * 이 값보다 밝고 색이 거의 없는 점을 배경으로 본다. 종이에 인쇄된 로고를 찍으면
     * 배경이 완전한 흰색(255)이 아니라 그림자가 섞여 230 대까지 내려간다.
     */
    const val THRESHOLD = 232

    /** 유채색 판정 여유. R·G·B 차이가 이보다 크면 색이 있는 점이라 보고 남긴다. */
    const val TOLERANCE = 18

    /** [r],[g],[b] 점을 배경(= 지울 점)으로 볼지. */
    fun isBackground(r: Int, g: Int, b: Int, threshold: Int = THRESHOLD): Boolean {
        if (r < threshold || g < threshold || b < threshold) return false
        val highest = maxOf(r, g, b)
        val lowest = minOf(r, g, b)
        return highest - lowest <= TOLERANCE
    }
}
