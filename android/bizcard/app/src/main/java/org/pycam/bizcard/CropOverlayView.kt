package org.pycam.bizcard

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.min

/**
 * 사진을 보여주고 그 위에서 명함 영역을 손으로 잡게 하는 뷰.
 *
 * 선택 영역은 비트맵 픽셀 좌표로 들고 있어서 화면 크기가 바뀌어도 그대로 유지된다.
 * 계산은 [CropGeometry] 가 담당하고 이 클래스는 그리기와 터치 처리만 한다.
 */
class CropOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var bitmap: Bitmap? = null

    /** 비트맵 픽셀 좌표의 선택 영역. */
    private var selection: CropGeometry.Rect? = null

    private var activeHandle = CropGeometry.Handle.NONE
    private var lastX = 0f
    private var lastY = 0f

    private val density = resources.displayMetrics.density

    private val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = true }
    private val scrimPaint = Paint().apply { color = 0x99000000.toInt() }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 2f * density
    }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x66FFFFFF
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 4f * density
        strokeCap = Paint.Cap.ROUND
    }

    private val sourceRect = Rect()
    private val targetRect = RectF()

    /** 사진을 얹는다. 선택 영역은 사진 안쪽으로 조금 들어온 사각형으로 초기화한다. */
    fun setBitmap(value: Bitmap, initial: CardCrop.Box? = null) {
        bitmap = value
        val bounds = CropGeometry.Rect(0f, 0f, value.width.toFloat(), value.height.toFloat())
        selection = initial
            ?.let { box ->
                CropGeometry.clamp(
                    CropGeometry.Rect(
                        box.left.toFloat(),
                        box.top.toFloat(),
                        box.right.toFloat(),
                        box.bottom.toFloat()
                    ),
                    bounds
                )
            }
            ?: CropGeometry.initial(bounds)
        invalidate()
    }

    /** 선택 영역을 사진 거의 전체로 되돌린다. */
    fun reset() {
        val value = bitmap ?: return
        selection = CropGeometry.initial(
            CropGeometry.Rect(0f, 0f, value.width.toFloat(), value.height.toFloat()),
            inset = 0.02f
        )
        invalidate()
    }

    /** 지금 선택한 영역. 비트맵 픽셀 좌표다. */
    fun selectionBox(): CardCrop.Box? {
        val value = bitmap ?: return null
        val rect = selection ?: return null
        val left = rect.left.toInt().coerceIn(0, value.width - 1)
        val top = rect.top.toInt().coerceIn(0, value.height - 1)
        val right = rect.right.toInt().coerceIn(left + 1, value.width)
        val bottom = rect.bottom.toInt().coerceIn(top + 1, value.height)
        return CardCrop.Box(left, top, right, bottom)
    }

    /** 선택 영역이 사진 거의 전체라서 잘라낼 것이 없는지. */
    fun isWholeImage(): Boolean {
        val value = bitmap ?: return true
        val box = selectionBox() ?: return true
        val coverage = box.area.toFloat() / (value.width.toLong() * value.height).toFloat()
        return coverage >= 0.995f
    }

    // ------------------------------------------------------------------ 그리기

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val value = bitmap ?: return
        val bounds = imageBounds() ?: return

        sourceRect.set(0, 0, value.width, value.height)
        targetRect.set(bounds.left, bounds.top, bounds.right, bounds.bottom)
        canvas.drawBitmap(value, sourceRect, targetRect, imagePaint)

        val rect = selection?.let { toDisplay(it, bounds, value) } ?: return

        // 선택 영역 밖을 어둡게 덮는다.
        canvas.drawRect(bounds.left, bounds.top, bounds.right, rect.top, scrimPaint)
        canvas.drawRect(bounds.left, rect.bottom, bounds.right, bounds.bottom, scrimPaint)
        canvas.drawRect(bounds.left, rect.top, rect.left, rect.bottom, scrimPaint)
        canvas.drawRect(rect.right, rect.top, bounds.right, rect.bottom, scrimPaint)

        val thirdX = rect.width / 3f
        val thirdY = rect.height / 3f
        canvas.drawLine(rect.left + thirdX, rect.top, rect.left + thirdX, rect.bottom, gridPaint)
        canvas.drawLine(rect.right - thirdX, rect.top, rect.right - thirdX, rect.bottom, gridPaint)
        canvas.drawLine(rect.left, rect.top + thirdY, rect.right, rect.top + thirdY, gridPaint)
        canvas.drawLine(rect.left, rect.bottom - thirdY, rect.right, rect.bottom - thirdY, gridPaint)

        canvas.drawRect(rect.left, rect.top, rect.right, rect.bottom, borderPaint)
        drawCorners(canvas, rect)
    }

    private fun drawCorners(canvas: Canvas, rect: CropGeometry.Rect) {
        val arm = min(rect.width, rect.height) * 0.18f
        val limit = 28f * density
        val length = min(arm, limit).coerceAtLeast(8f * density)

        canvas.drawLine(rect.left, rect.top, rect.left + length, rect.top, handlePaint)
        canvas.drawLine(rect.left, rect.top, rect.left, rect.top + length, handlePaint)
        canvas.drawLine(rect.right, rect.top, rect.right - length, rect.top, handlePaint)
        canvas.drawLine(rect.right, rect.top, rect.right, rect.top + length, handlePaint)
        canvas.drawLine(rect.left, rect.bottom, rect.left + length, rect.bottom, handlePaint)
        canvas.drawLine(rect.left, rect.bottom, rect.left, rect.bottom - length, handlePaint)
        canvas.drawLine(rect.right, rect.bottom, rect.right - length, rect.bottom, handlePaint)
        canvas.drawLine(rect.right, rect.bottom, rect.right, rect.bottom - length, handlePaint)
    }

    // ------------------------------------------------------------------ 터치

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val value = bitmap ?: return false
        val bounds = imageBounds() ?: return false
        val rect = selection ?: return false
        val scale = displayScale(bounds, value)
        if (scale <= 0f) return false

        val imageBoundsRect = CropGeometry.Rect(0f, 0f, value.width.toFloat(), value.height.toFloat())
        val x = (event.x - bounds.left) / scale
        val y = (event.y - bounds.top) / scale

        return when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                activeHandle = CropGeometry.handleAt(rect, x, y, TOUCH_SLOP_DP * density / scale)
                lastX = x
                lastY = y
                if (activeHandle != CropGeometry.Handle.NONE) {
                    parent?.requestDisallowInterceptTouchEvent(true)
                    true
                } else {
                    false
                }
            }

            MotionEvent.ACTION_MOVE -> {
                if (activeHandle == CropGeometry.Handle.NONE) return false
                selection = CropGeometry.drag(
                    rect,
                    activeHandle,
                    x - lastX,
                    y - lastY,
                    imageBoundsRect,
                    MIN_BOX_DP * density / scale
                )
                lastX = x
                lastY = y
                invalidate()
                true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                activeHandle = CropGeometry.Handle.NONE
                parent?.requestDisallowInterceptTouchEvent(false)
                true
            }

            else -> false
        }
    }

    // ------------------------------------------------------------------ 좌표 변환

    /** 뷰 안에서 사진이 차지하는 영역(fitCenter). */
    private fun imageBounds(): CropGeometry.Rect? {
        val value = bitmap ?: return null
        if (width <= 0 || height <= 0 || value.width <= 0 || value.height <= 0) return null

        val scale = min(width.toFloat() / value.width, height.toFloat() / value.height)
        val drawWidth = value.width * scale
        val drawHeight = value.height * scale
        val left = (width - drawWidth) / 2f
        val top = (height - drawHeight) / 2f
        return CropGeometry.Rect(left, top, left + drawWidth, top + drawHeight)
    }

    private fun displayScale(bounds: CropGeometry.Rect, value: Bitmap): Float =
        if (value.width <= 0) 0f else bounds.width / value.width

    private fun toDisplay(
        rect: CropGeometry.Rect,
        bounds: CropGeometry.Rect,
        value: Bitmap
    ): CropGeometry.Rect {
        val scale = displayScale(bounds, value)
        return CropGeometry.Rect(
            bounds.left + rect.left * scale,
            bounds.top + rect.top * scale,
            bounds.left + rect.right * scale,
            bounds.top + rect.bottom * scale
        )
    }

    private companion object {
        /** 모서리를 잡았다고 볼 여유 거리 (dp). */
        const val TOUCH_SLOP_DP = 24f

        /** 선택 영역의 최소 변 길이 (dp). */
        const val MIN_BOX_DP = 48f
    }
}
