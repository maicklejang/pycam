package org.pycam.bizcard

import android.graphics.Bitmap
import android.graphics.Color

/**
 * [BarcodeEncoder] 가 만든 QR 격자를 비트맵으로 옮긴다.
 *
 * 미리보기는 글자를 칠 때마다 다시 그려지는데 같은 내용을 되풀이해 만들 이유가 없어서
 * 마지막으로 만든 한 장은 들고 있는다.
 */
object BarcodeRenderer {

    private var cachedPayload: String? = null
    private var cachedSize: Int = 0
    private var cached: Bitmap? = null

    /**
     * [payload] 를 한 변 [maxSize] 픽셀 이하의 QR 그림으로 만든다. 만들 수 없으면 null.
     *
     * 모듈 하나가 정수 픽셀로 떨어지는 크기로 맞춰서 칸 폭이 들쭉날쭉해지지 않게 한다.
     * 돌려준 비트맵은 이 객체가 다시 쓸 수 있으므로 **받은 쪽에서 recycle 하지 않는다.**
     */
    fun render(payload: String, maxSize: Int): Bitmap? {
        if (payload.isBlank() || maxSize < BarcodeEncoder.MIN_SIZE) return null

        val size = BarcodeEncoder.fittedSize(payload, maxSize) ?: return null
        val reusable = cached
        if (reusable != null && !reusable.isRecycled && cachedPayload == payload && cachedSize == size) {
            return reusable
        }

        val matrix = BarcodeEncoder.encode(payload, size) ?: return null
        val width = matrix.width
        val height = matrix.height
        val pixels = IntArray(width * height)
        for (y in 0 until height) {
            val row = y * width
            for (x in 0 until width) {
                pixels[row + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
            }
        }

        val bitmap = try {
            Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
        } catch (e: Exception) {
            return null
        }

        cachedPayload = payload
        cachedSize = size
        cached = bitmap
        return bitmap
    }

    /** 들고 있던 그림을 버린다. 화면을 닫을 때 부른다. */
    fun clearCache() {
        cachedPayload = null
        cachedSize = 0
        cached = null
    }
}
