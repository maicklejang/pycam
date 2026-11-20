package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupPlanTest {

    @Test
    fun `앱이 만드는 사진 이름은 모두 통과한다`() {
        val name = "card_1731999999999_0f8f2b1e-1b2c-4a5d-9e6f-7a8b9c0d1e2f.jpg"
        assertEquals(name, BackupPlan.safeName(name))
    }

    @Test
    fun `디렉터리를 거슬러 올라가는 이름은 받지 않는다`() {
        assertNull(BackupPlan.safeName(".."))
        assertNull(BackupPlan.safeName("../cards.json"))
        assertNull(BackupPlan.safeName("a/../b.jpg"))
        assertNull(BackupPlan.safeName("/etc/passwd"))
        assertNull(BackupPlan.safeName("sub/dir.jpg"))
        assertNull(BackupPlan.safeName("back\\slash.jpg"))
        assertNull(BackupPlan.safeName(".hidden"))
        assertNull(BackupPlan.safeName(""))
    }

    @Test
    fun `압축 항목 이름과 사진 이름을 서로 옮긴다`() {
        val name = "card_1.jpg"
        val entry = BackupPlan.imageEntry(name)
        assertEquals("images/card_1.jpg", entry)
        assertEquals(name, BackupPlan.imageNameFrom(entry))
    }

    @Test
    fun `사진 디렉터리 밖의 항목은 사진으로 보지 않는다`() {
        assertNull(BackupPlan.imageNameFrom("manifest.json"))
        assertNull(BackupPlan.imageNameFrom("my_card.jpg"))
        assertNull(BackupPlan.imageNameFrom("images/../../evil.jpg"))
        assertNull(BackupPlan.imageNameFrom("images/nested/card.jpg"))
    }

    @Test
    fun `백업 파일 이름에 날짜와 시각이 들어간다`() {
        assertEquals("bizcard-backup-20261120-0905.zip", BackupPlan.fileName(2026, 11, 20, 9, 5))
    }

    @Test
    fun `복원은 기존 기록을 지우지 않고 더한다`() {
        val existing = listOf(
            BizCard(name = "기존", imageName = "a.jpg", savedAt = 100)
        )
        val incoming = listOf(
            BizCard(name = "새 기록", imageName = "b.jpg", savedAt = 200)
        )
        val merged = BackupPlan.merge(existing, incoming)
        assertEquals(2, merged.size)
        assertEquals(listOf("새 기록", "기존"), merged.map { it.name })
    }

    @Test
    fun `같은 사진을 가리키는 항목은 나중에 저장된 쪽을 남긴다`() {
        val existing = listOf(BizCard(name = "옛 이름", imageName = "a.jpg", savedAt = 100))
        val incoming = listOf(BizCard(name = "새 이름", imageName = "a.jpg", savedAt = 300))
        val merged = BackupPlan.merge(existing, incoming)
        assertEquals(1, merged.size)
        assertEquals("새 이름", merged.first().name)
    }

    @Test
    fun `기기에 있는 기록이 더 새로우면 백업 쪽을 덮어쓰지 않는다`() {
        val existing = listOf(BizCard(name = "고쳐 둔 이름", imageName = "a.jpg", savedAt = 500))
        val incoming = listOf(BizCard(name = "백업 당시 이름", imageName = "a.jpg", savedAt = 100))
        val merged = BackupPlan.merge(existing, incoming)
        assertEquals(1, merged.size)
        assertEquals("고쳐 둔 이름", merged.first().name)
    }

    @Test
    fun `사진 이름이 없는 항목은 서로 합치지 않는다`() {
        val existing = listOf(BizCard(name = "손으로 적은 하나", savedAt = 10))
        val incoming = listOf(BizCard(name = "손으로 적은 둘", savedAt = 20))
        assertEquals(2, BackupPlan.merge(existing, incoming).size)
    }

    @Test
    fun `합친 결과는 한도까지만 남는다`() {
        val many = (1..600).map { BizCard(imageName = "card_$it.jpg", savedAt = it.toLong()) }
        val merged = BackupPlan.merge(emptyList(), many, limit = 500)
        assertEquals(500, merged.size)
        // 최근 것부터 남는다.
        assertEquals("card_600.jpg", merged.first().imageName)
    }

    @Test
    fun `기록에 없는 사진은 꺼내지 않는다`() {
        val cards = listOf(
            BizCard(imageName = "a.jpg"),
            BizCard(imageName = ""),
            BizCard(imageName = "../evil.jpg")
        )
        val needed = BackupPlan.neededImages(cards)
        assertEquals(setOf("a.jpg"), needed)
    }

    @Test
    fun `집계가 비었는지 알려준다`() {
        assertTrue(BackupSummary().isEmpty)
        assertFalse(BackupSummary(cards = 1).isEmpty)
        assertFalse(BackupSummary(logo = true).isEmpty)
    }
}
