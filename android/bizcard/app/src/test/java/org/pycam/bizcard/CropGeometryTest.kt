package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CropGeometryTest {

    private val bounds = CropGeometry.Rect(0f, 0f, 1000f, 600f)

    @Test
    fun `처음 영역은 사진 안쪽으로 들어온다`() {
        val rect = CropGeometry.initial(bounds, inset = 0.1f)
        assertEquals(100f, rect.left, 0.01f)
        assertEquals(60f, rect.top, 0.01f)
        assertEquals(900f, rect.right, 0.01f)
        assertEquals(540f, rect.bottom, 0.01f)
    }

    @Test
    fun `모서리를 먼저 잡는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        assertEquals(CropGeometry.Handle.TOP_LEFT, CropGeometry.handleAt(rect, 105f, 103f, 20f))
        assertEquals(CropGeometry.Handle.BOTTOM_RIGHT, CropGeometry.handleAt(rect, 495f, 397f, 20f))
    }

    @Test
    fun `변과 내부도 잡는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        assertEquals(CropGeometry.Handle.LEFT, CropGeometry.handleAt(rect, 102f, 250f, 20f))
        assertEquals(CropGeometry.Handle.BOTTOM, CropGeometry.handleAt(rect, 300f, 398f, 20f))
        assertEquals(CropGeometry.Handle.INSIDE, CropGeometry.handleAt(rect, 300f, 250f, 20f))
    }

    @Test
    fun `멀리 떨어진 곳은 잡히지 않는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        assertEquals(CropGeometry.Handle.NONE, CropGeometry.handleAt(rect, 20f, 20f, 20f))
    }

    @Test
    fun `모서리를 끌어도 사진 밖으로 나가지 않는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        val dragged = CropGeometry.drag(
            rect, CropGeometry.Handle.TOP_LEFT, -9999f, -9999f, bounds, minSize = 50f
        )
        assertEquals(bounds.left, dragged.left, 0.01f)
        assertEquals(bounds.top, dragged.top, 0.01f)
        assertEquals(500f, dragged.right, 0.01f)
    }

    @Test
    fun `최소 크기보다 작아지지 않는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        val dragged = CropGeometry.drag(
            rect, CropGeometry.Handle.RIGHT, -9999f, 0f, bounds, minSize = 80f
        )
        assertEquals(180f, dragged.right, 0.01f)
        assertTrue(dragged.width >= 80f)
    }

    @Test
    fun `전체를 끌면 크기는 그대로다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        val moved = CropGeometry.drag(rect, CropGeometry.Handle.INSIDE, 50f, -30f, bounds, 50f)
        assertEquals(rect.width, moved.width, 0.01f)
        assertEquals(rect.height, moved.height, 0.01f)
        assertEquals(150f, moved.left, 0.01f)
        assertEquals(70f, moved.top, 0.01f)
    }

    @Test
    fun `끌어서 밖으로 나가려 하면 경계에 붙는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        val moved = CropGeometry.move(rect, 9999f, 9999f, bounds)
        assertEquals(bounds.right, moved.right, 0.01f)
        assertEquals(bounds.bottom, moved.bottom, 0.01f)
        assertEquals(rect.width, moved.width, 0.01f)
    }

    @Test
    fun `잡지 않은 상태에서는 사각형이 바뀌지 않는다`() {
        val rect = CropGeometry.Rect(100f, 100f, 500f, 400f)
        assertEquals(rect, CropGeometry.drag(rect, CropGeometry.Handle.NONE, 50f, 50f, bounds, 10f))
    }

    @Test
    fun `화면 좌표를 이미지 픽셀로 바꾼다`() {
        // 사진은 화면에서 (0,0)-(500,300) 에 그려지고 원본은 1000x600 이다.
        val drawn = CropGeometry.Rect(0f, 0f, 500f, 300f)
        val box = CropGeometry.toImage(
            CropGeometry.Rect(100f, 60f, 400f, 240f), drawn, 1000, 600
        )
        assertNotNull(box)
        assertEquals(200, box!!.left)
        assertEquals(120, box.top)
        assertEquals(800, box.right)
        assertEquals(480, box.bottom)
    }

    @Test
    fun `이미지 좌표와 화면 좌표를 왕복해도 어긋나지 않는다`() {
        val drawn = CropGeometry.Rect(20f, 10f, 520f, 310f)
        val original = CardCrop.Box(200, 120, 800, 480)
        val onScreen = CropGeometry.fromImage(original, drawn, 1000, 600)
        assertNotNull(onScreen)
        val roundTrip = CropGeometry.toImage(onScreen!!, drawn, 1000, 600)
        assertNotNull(roundTrip)
        assertEquals(original.left, roundTrip!!.left)
        assertEquals(original.top, roundTrip.top)
        assertEquals(original.right, roundTrip.right)
        assertEquals(original.bottom, roundTrip.bottom)
    }

    @Test
    fun `그려진 영역이 없으면 변환하지 않는다`() {
        val empty = CropGeometry.Rect(0f, 0f, 0f, 0f)
        assertNull(CropGeometry.toImage(CropGeometry.Rect(0f, 0f, 10f, 10f), empty, 100, 100))
        assertNull(CropGeometry.toImage(CropGeometry.Rect(0f, 0f, 10f, 10f), bounds, 0, 0))
    }

    @Test
    fun `사진 밖으로 삐져나온 사각형은 잘라 맞춘다`() {
        val clamped = CropGeometry.clamp(CropGeometry.Rect(-50f, -50f, 1200f, 800f), bounds)
        assertEquals(bounds, clamped)
    }
}
