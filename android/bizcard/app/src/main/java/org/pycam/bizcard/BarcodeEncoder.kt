package org.pycam.bizcard

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/**
 * 글자를 QR 격자로 만든다. zxing(순수 자바)만 쓰고 안드로이드 그림판은 건드리지 않으므로
 * JVM 단위 테스트로 검증할 수 있다. 실제로 비트맵에 옮기는 일은 [BarcodeRenderer] 가 한다.
 */
object BarcodeEncoder {

    /**
     * 오류 복원 수준. 명함은 손으로 만지고 접히기도 해서 조금 넉넉하게 M 을 쓴다.
     * (L 이 가장 촘촘하지 않지만 긁히면 못 읽는다.)
     */
    val CORRECTION: ErrorCorrectionLevel = ErrorCorrectionLevel.M

    /** QR 테두리 여백(모듈 수). 1 보다 작으면 읽히지 않는다. */
    const val QUIET_ZONE = 1

    private val HINTS: Map<EncodeHintType, Any> = mapOf(
        EncodeHintType.CHARACTER_SET to "UTF-8",
        EncodeHintType.ERROR_CORRECTION to CORRECTION,
        EncodeHintType.MARGIN to QUIET_ZONE
    )

    /**
     * [payload] 를 한 변 [size] 픽셀의 QR 격자로 만든다. 만들 수 없으면 null.
     */
    fun encode(payload: String, size: Int): BitMatrix? {
        if (payload.isBlank() || size < MIN_SIZE) return null
        return try {
            QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, HINTS)
        } catch (e: Exception) {
            // 내용이 너무 길거나 담을 수 없는 글자가 섞인 경우.
            null
        }
    }

    /**
     * 여백을 뺀 격자 한 변의 모듈 수. 이 값이 클수록 칸이 촘촘해서 작게 인쇄하면 못 읽는다.
     * 담을 내용의 길이를 가늠할 때 쓴다. 만들 수 없으면 null.
     */
    fun moduleCount(payload: String): Int? {
        if (payload.isBlank()) return null
        return try {
            Encoder.encode(payload, CORRECTION, HINTS).version.dimensionForVersion
        } catch (e: Exception) {
            null
        }
    }

    /**
     * [maxSize] 를 넘지 않으면서 모듈 하나가 정수 픽셀로 떨어지는 가장 큰 변 길이.
     * 이렇게 맞추면 모듈 폭이 들쭉날쭉하지 않아 작게 넣어도 잘 읽힌다. 만들 수 없으면 null.
     */
    fun fittedSize(payload: String, maxSize: Int): Int? {
        val modules = moduleCount(payload) ?: return null
        val side = modules + QUIET_ZONE * 2
        if (maxSize < side) return null
        val multiple = maxSize / side
        return side * multiple
    }

    /** 명함에 넣을 QR 의 최소 변 길이. 이보다 작으면 만들지 않는다. */
    const val MIN_SIZE = 21
}
