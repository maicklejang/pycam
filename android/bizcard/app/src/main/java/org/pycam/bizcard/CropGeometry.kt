package org.pycam.bizcard

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 사용자가 손으로 명함 영역을 잡을 때 쓰는 사각형 계산.
 *
 * 좌표는 화면에 그려진 사진의 영역(= [Rect] bounds) 기준이고, 마지막에 [toImage] 로
 * 이미지 픽셀 좌표로 바꾼다. 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라
 * JVM 단위 테스트로 검증한다.
 */
object CropGeometry {

    data class Rect(val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val width: Float get() = right - left
        val height: Float get() = bottom - top
        val centerX: Float get() = (left + right) / 2f
        val centerY: Float get() = (top + bottom) / 2f
    }

    /** 잡을 수 있는 부분. [INSIDE] 는 사각형 전체를 끌어서 옮기는 경우다. */
    enum class Handle {
        TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT,
        LEFT, TOP, RIGHT, BOTTOM,
        INSIDE, NONE
    }

    /** 처음 보여줄 선택 영역. 사진 가장자리에서 [inset] 비율만큼 안쪽으로 들어온 사각형. */
    fun initial(bounds: Rect, inset: Float = 0.08f): Rect {
        val dx = bounds.width * inset
        val dy = bounds.height * inset
        return Rect(bounds.left + dx, bounds.top + dy, bounds.right - dx, bounds.bottom - dy)
    }

    /**
     * ([x], [y]) 에서 잡히는 부분을 찾는다. 모서리를 먼저 보고, 그다음 변, 마지막으로 내부다.
     * [touchRadius] 는 손가락이 닿았다고 볼 여유 거리.
     */
    fun handleAt(rect: Rect, x: Float, y: Float, touchRadius: Float): Handle {
        val nearLeft = abs(x - rect.left) <= touchRadius
        val nearRight = abs(x - rect.right) <= touchRadius
        val nearTop = abs(y - rect.top) <= touchRadius
        val nearBottom = abs(y - rect.bottom) <= touchRadius
        val withinX = x >= rect.left - touchRadius && x <= rect.right + touchRadius
        val withinY = y >= rect.top - touchRadius && y <= rect.bottom + touchRadius

        if (nearLeft && nearTop) return Handle.TOP_LEFT
        if (nearRight && nearTop) return Handle.TOP_RIGHT
        if (nearLeft && nearBottom) return Handle.BOTTOM_LEFT
        if (nearRight && nearBottom) return Handle.BOTTOM_RIGHT
        if (nearLeft && withinY) return Handle.LEFT
        if (nearRight && withinY) return Handle.RIGHT
        if (nearTop && withinX) return Handle.TOP
        if (nearBottom && withinX) return Handle.BOTTOM
        if (x > rect.left && x < rect.right && y > rect.top && y < rect.bottom) return Handle.INSIDE
        return Handle.NONE
    }

    /**
     * [handle] 을 ([dx], [dy]) 만큼 끌었을 때의 사각형. 항상 [bounds] 안에 머물고
     * 변의 길이는 [minSize] 보다 작아지지 않는다.
     */
    fun drag(rect: Rect, handle: Handle, dx: Float, dy: Float, bounds: Rect, minSize: Float): Rect {
        if (handle == Handle.NONE) return rect
        if (handle == Handle.INSIDE) return move(rect, dx, dy, bounds)

        var left = rect.left
        var top = rect.top
        var right = rect.right
        var bottom = rect.bottom

        val movesLeft = handle == Handle.LEFT || handle == Handle.TOP_LEFT || handle == Handle.BOTTOM_LEFT
        val movesRight = handle == Handle.RIGHT || handle == Handle.TOP_RIGHT || handle == Handle.BOTTOM_RIGHT
        val movesTop = handle == Handle.TOP || handle == Handle.TOP_LEFT || handle == Handle.TOP_RIGHT
        val movesBottom = handle == Handle.BOTTOM || handle == Handle.BOTTOM_LEFT || handle == Handle.BOTTOM_RIGHT

        if (movesLeft) left = (left + dx).coerceIn(bounds.left, right - minSize)
        if (movesRight) right = (right + dx).coerceIn(left + minSize, bounds.right)
        if (movesTop) top = (top + dy).coerceIn(bounds.top, bottom - minSize)
        if (movesBottom) bottom = (bottom + dy).coerceIn(top + minSize, bounds.bottom)

        return Rect(left, top, right, bottom)
    }

    /** 크기를 유지한 채 사각형을 옮긴다. [bounds] 를 벗어나려 하면 경계에 붙는다. */
    fun move(rect: Rect, dx: Float, dy: Float, bounds: Rect): Rect {
        val maxDx = bounds.right - rect.right
        val minDx = bounds.left - rect.left
        val maxDy = bounds.bottom - rect.bottom
        val minDy = bounds.top - rect.top
        val shiftX = dx.coerceIn(min(minDx, maxDx), max(minDx, maxDx))
        val shiftY = dy.coerceIn(min(minDy, maxDy), max(minDy, maxDy))
        return Rect(rect.left + shiftX, rect.top + shiftY, rect.right + shiftX, rect.bottom + shiftY)
    }

    /** [bounds] 안에 들어오도록 자른다. 들어갈 수 없으면 [bounds] 그대로 돌려준다. */
    fun clamp(rect: Rect, bounds: Rect): Rect {
        val left = rect.left.coerceIn(bounds.left, bounds.right)
        val top = rect.top.coerceIn(bounds.top, bounds.bottom)
        val right = rect.right.coerceIn(left, bounds.right)
        val bottom = rect.bottom.coerceIn(top, bounds.bottom)
        if (right - left <= 0f || bottom - top <= 0f) return bounds
        return Rect(left, top, right, bottom)
    }

    /**
     * 화면 좌표 [rect] 를 [imageWidth] x [imageHeight] 픽셀 좌표의 [CardCrop.Box] 로 바꾼다.
     * [bounds] 는 화면에 그려진 사진 전체의 영역이다.
     */
    fun toImage(rect: Rect, bounds: Rect, imageWidth: Int, imageHeight: Int): CardCrop.Box? {
        if (bounds.width <= 0f || bounds.height <= 0f) return null
        if (imageWidth <= 0 || imageHeight <= 0) return null

        val scaleX = imageWidth / bounds.width
        val scaleY = imageHeight / bounds.height
        val left = ((rect.left - bounds.left) * scaleX).toInt().coerceIn(0, imageWidth - 1)
        val top = ((rect.top - bounds.top) * scaleY).toInt().coerceIn(0, imageHeight - 1)
        val right = ((rect.right - bounds.left) * scaleX).toInt().coerceIn(left + 1, imageWidth)
        val bottom = ((rect.bottom - bounds.top) * scaleY).toInt().coerceIn(top + 1, imageHeight)
        return CardCrop.Box(left, top, right, bottom)
    }

    /** [toImage] 의 반대. 저장해 둔 영역을 화면에 다시 얹을 때 쓴다. */
    fun fromImage(box: CardCrop.Box, bounds: Rect, imageWidth: Int, imageHeight: Int): Rect? {
        if (imageWidth <= 0 || imageHeight <= 0) return null
        val scaleX = bounds.width / imageWidth
        val scaleY = bounds.height / imageHeight
        return clamp(
            Rect(
                bounds.left + box.left * scaleX,
                bounds.top + box.top * scaleY,
                bounds.left + box.right * scaleX,
                bounds.top + box.bottom * scaleY
            ),
            bounds
        )
    }
}
