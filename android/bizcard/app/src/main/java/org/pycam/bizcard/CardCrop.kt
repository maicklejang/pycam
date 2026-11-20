package org.pycam.bizcard

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * 촬영한 사진에서 명함이 차지하는 영역만 골라낸다.
 *
 * OCR 이 찾아낸 글자 상자들의 분포를 근거로 삼는다. 글자는 명함 안에만 있으므로,
 * 상자들을 감싸는 사각형에 여백을 더하고 명함 비율로 넓히면 배경을 걷어낼 수 있다.
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라 JVM 단위 테스트로 검증한다.
 */
object CardCrop {

    /** 이미지 좌표계(가로 x, 세로 y, 좌상단 원점)의 사각형. */
    data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width: Int get() = right - left
        val height: Int get() = bottom - top
        val area: Long get() = width.toLong() * height.toLong()
    }

    /** 표준 명함 가로세로 비율 (85.6mm x 54mm). */
    const val CARD_ASPECT = 85.6f / 54f

    /** 잘라낸 영역이 원본의 이 비율을 넘으면 잘라낼 것이 없다고 본다. */
    private const val MAX_COVERAGE = 0.92f

    /** 잘라낸 영역이 원본의 이 비율보다 작으면 인식이 잘못된 것으로 본다. */
    private const val MIN_COVERAGE = 0.04f

    /** 이 간격(사진 짧은 변 대비) 안에 있는 글자 상자끼리 한 덩어리로 묶는다. */
    private const val CLUSTER_GAP = 0.3f

    /** 이 비율 범위 안에서만 명함 비율로 넓힌다. 지나치게 길쭉하면 명함으로 보지 않는다. */
    private const val MIN_EXPAND_ASPECT = 0.5f
    private const val MAX_EXPAND_ASPECT = 2.4f

    /**
     * 글자 상자들로부터 명함 영역을 추정한다. 잘라낼 필요가 없거나 근거가 부족하면
     * null 을 돌려주고, 호출한 쪽은 원본을 그대로 쓴다.
     *
     * [imageWidth], [imageHeight] 는 [boxes] 와 같은 좌표계(EXIF 회전이 반영된 상태)여야 한다.
     */
    fun detect(boxes: List<Box>, imageWidth: Int, imageHeight: Int): Box? {
        if (imageWidth <= 0 || imageHeight <= 0) return null
        val usable = boxes.filter { it.width > 0 && it.height > 0 }
        if (usable.isEmpty()) return null

        // 배경에서 잘못 잡힌 글자가 영역을 늘리지 않도록, 서로 가까이 모여 있는
        // 상자들만 남긴다. 명함 위의 글줄은 사진 크기에 비해 촘촘히 붙어 있다.
        val gap = (min(imageWidth, imageHeight) * CLUSTER_GAP).roundToInt()
        val cluster = largestCluster(usable, gap)
        if (cluster.isEmpty()) return null

        val bounds = union(cluster)

        // 글자 높이에 비례한 여백을 둬서 테두리와 로고가 잘려나가지 않게 한다.
        val medianHeight = median(cluster.map { it.height })
        val padding = max(medianHeight * 0.7f, min(imageWidth, imageHeight) * 0.02f).roundToInt()
        val padded = Box(
            bounds.left - padding,
            bounds.top - padding,
            bounds.right + padding,
            bounds.bottom + padding
        )

        var box = clamp(padded, imageWidth, imageHeight)
        if (box.width <= 0 || box.height <= 0) return null
        box = expandToCardAspect(box, imageWidth, imageHeight)

        val coverage = box.area.toFloat() / (imageWidth.toLong() * imageHeight).toFloat()
        if (coverage >= MAX_COVERAGE || coverage <= MIN_COVERAGE) return null
        return box
    }

    /**
     * 가로·세로 간격이 [gap] 이내면 이웃으로 보고 이어 붙인 뒤, 넓이 합이 가장 큰
     * 덩어리를 고른다. 멀리 떨어져 홀로 잡힌 글자는 자연히 떨어져 나간다.
     */
    private fun largestCluster(boxes: List<Box>, gap: Int): List<Box> {
        val visited = BooleanArray(boxes.size)
        var best: List<Box> = emptyList()
        var bestArea = 0L

        for (seed in boxes.indices) {
            if (visited[seed]) continue
            val group = ArrayList<Box>()
            val queue = ArrayDeque<Int>()
            queue += seed
            visited[seed] = true
            while (queue.isNotEmpty()) {
                val current = queue.removeFirst()
                group += boxes[current]
                for (other in boxes.indices) {
                    if (!visited[other] && connected(boxes[current], boxes[other], gap)) {
                        visited[other] = true
                        queue += other
                    }
                }
            }
            val area = group.sumOf { it.area }
            if (area > bestArea) {
                bestArea = area
                best = group
            }
        }
        return best
    }

    private fun connected(a: Box, b: Box, gap: Int): Boolean =
        axisGap(a.left, a.right, b.left, b.right) <= gap &&
            axisGap(a.top, a.bottom, b.top, b.bottom) <= gap

    /** 두 구간이 겹치면 0, 떨어져 있으면 그 거리. */
    private fun axisGap(aStart: Int, aEnd: Int, bStart: Int, bEnd: Int): Int =
        max(0, max(bStart - aEnd, aStart - bEnd))

    private fun union(boxes: List<Box>) = Box(
        left = boxes.minOf { it.left },
        top = boxes.minOf { it.top },
        right = boxes.maxOf { it.right },
        bottom = boxes.maxOf { it.bottom }
    )

    /**
     * 글자가 없는 로고·여백까지 담기도록 명함 비율에 가깝게 넓힌다. 줄이지는 않으며
     * 이미지 밖으로는 나가지 않는다. 세로로 긴 영역은 명함으로 보기 어려워 건드리지 않는다.
     */
    private fun expandToCardAspect(box: Box, imageWidth: Int, imageHeight: Int): Box {
        if (box.width <= 0 || box.height <= 0) return box
        val aspect = box.width.toFloat() / box.height
        if (aspect < MIN_EXPAND_ASPECT || aspect > MAX_EXPAND_ASPECT) return box

        var result = box
        if (aspect < CARD_ASPECT) {
            val target = (box.height * CARD_ASPECT).roundToInt()
            result = growHorizontally(result, target, imageWidth)
        } else {
            val target = (box.width / CARD_ASPECT).roundToInt()
            result = growVertically(result, target, imageHeight)
        }
        return clamp(result, imageWidth, imageHeight)
    }

    private fun growHorizontally(box: Box, targetWidth: Int, imageWidth: Int): Box {
        val extra = targetWidth - box.width
        if (extra <= 0) return box
        val leftRoom = box.left
        val rightRoom = imageWidth - box.right
        val takeLeft = min(extra / 2, leftRoom)
        val takeRight = min(extra - takeLeft, rightRoom)
        // 한쪽에 여유가 없으면 반대쪽에서 더 가져온다.
        val remaining = extra - takeLeft - takeRight
        val extraLeft = min(remaining, leftRoom - takeLeft)
        return Box(box.left - takeLeft - extraLeft, box.top, box.right + takeRight, box.bottom)
    }

    private fun growVertically(box: Box, targetHeight: Int, imageHeight: Int): Box {
        val extra = targetHeight - box.height
        if (extra <= 0) return box
        val topRoom = box.top
        val bottomRoom = imageHeight - box.bottom
        val takeTop = min(extra / 2, topRoom)
        val takeBottom = min(extra - takeTop, bottomRoom)
        val remaining = extra - takeTop - takeBottom
        val extraTop = min(remaining, topRoom - takeTop)
        return Box(box.left, box.top - takeTop - extraTop, box.right, box.bottom + takeBottom)
    }

    private fun clamp(box: Box, imageWidth: Int, imageHeight: Int) = Box(
        left = box.left.coerceIn(0, imageWidth),
        top = box.top.coerceIn(0, imageHeight),
        right = box.right.coerceIn(0, imageWidth),
        bottom = box.bottom.coerceIn(0, imageHeight)
    )

    private fun median(values: List<Int>): Float {
        val sorted = values.sorted()
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 1) {
            sorted[middle].toFloat()
        } else {
            (sorted[middle - 1] + sorted[middle]) / 2f
        }
    }
}
