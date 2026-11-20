package org.pycam.bizcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactGroupsTest {

    @Test
    fun `이름 없는 그룹은 걸러낸다`() {
        val normalized = ContactGroups.normalize(
            listOf(
                ContactGroup(1L, "영업팀"),
                ContactGroup(2L, "   "),
                ContactGroup(3L, "")
            )
        )
        assertEquals(listOf("영업팀"), normalized.map { it.title })
    }

    @Test
    fun `같은 id 가 두 번 오면 한 번만 남긴다`() {
        val normalized = ContactGroups.normalize(
            listOf(
                ContactGroup(7L, "거래처"),
                ContactGroup(7L, "거래처"),
                ContactGroup(8L, "동료")
            )
        )
        assertEquals(2, normalized.size)
        assertEquals(listOf(7L, 8L), normalized.map { it.id }.sorted())
    }

    @Test
    fun `이름순으로 정렬한다`() {
        val normalized = ContactGroups.normalize(
            listOf(
                ContactGroup(1L, "협력사"),
                ContactGroup(2L, "가족"),
                ContactGroup(3L, "동료")
            )
        )
        assertEquals(listOf("가족", "동료", "협력사"), normalized.map { it.title })
    }

    @Test
    fun `이름이 겹칠 때만 계정 이름을 덧붙인다`() {
        val groups = ContactGroups.normalize(
            listOf(
                ContactGroup(1L, "동료", accountName = "work@example.com"),
                ContactGroup(2L, "동료", accountName = "me@gmail.com"),
                ContactGroup(3L, "가족", accountName = "me@gmail.com")
            )
        )
        val labels = ContactGroups.labels(groups)
        assertEquals("가족", labels[0])
        assertTrue(labels[1].startsWith("동료 ("))
        assertTrue(labels[2].startsWith("동료 ("))
        assertTrue(labels.any { it.contains("work@example.com") })
    }

    @Test
    fun `멤버 수를 아는 그룹은 인원을 함께 보여준다`() {
        val labels = ContactGroups.labels(listOf(ContactGroup(1L, "영업팀", memberCount = 12)))
        assertEquals("영업팀 · 12명", labels.single())
    }

    @Test
    fun `멤버 수가 0이면 인원을 적지 않는다`() {
        val labels = ContactGroups.labels(listOf(ContactGroup(1L, "영업팀", memberCount = 0)))
        assertEquals("영업팀", labels.single())
    }

    @Test
    fun `한 계정의 그룹만 남긴다`() {
        val picked = listOf(
            ContactGroup(1L, "동료", accountName = "me@gmail.com", accountType = "com.google"),
            ContactGroup(2L, "가족", accountName = "me@gmail.com", accountType = "com.google"),
            ContactGroup(3L, "거래처", accountName = "work@example.com", accountType = "com.exchange")
        )
        val usable = ContactGroups.sameAccount(picked)
        assertEquals(listOf(1L, 2L), usable.map { it.id })
    }

    @Test
    fun `고른 그룹이 없으면 계정 추림도 빈 목록이다`() {
        assertTrue(ContactGroups.sameAccount(emptyList()).isEmpty())
    }

    @Test
    fun `지정한 계정의 그룹만 골라낸다`() {
        val groups = listOf(
            ContactGroup(1L, "동료", accountName = "me@gmail.com", accountType = "com.google"),
            ContactGroup(2L, "거래처", accountName = "work@example.com", accountType = "com.exchange")
        )
        assertEquals(
            listOf(2L),
            ContactGroups.inAccount(groups, "work@example.com", "com.exchange").map { it.id }
        )
        // 계정이 없는 기기 로컬 연락처는 빈 문자열로 맞춘다.
        assertTrue(ContactGroups.inAccount(groups, null, null).isEmpty())
        assertEquals(
            listOf(3L),
            ContactGroups.inAccount(
                groups + ContactGroup(3L, "로컬"), null, null
            ).map { it.id }
        )
    }

    @Test
    fun `선택한 그룹만 요약한다`() {
        val groups = listOf(
            ContactGroup(1L, "가족"),
            ContactGroup(2L, "동료"),
            ContactGroup(3L, "거래처")
        )
        assertEquals("가족, 거래처", ContactGroups.summary(groups, setOf(1L, 3L)))
        assertEquals("", ContactGroups.summary(groups, emptySet()))
    }
}
