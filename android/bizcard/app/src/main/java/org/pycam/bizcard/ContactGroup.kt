package org.pycam.bizcard

/**
 * 기기 주소록의 연락처 그룹 한 개.
 *
 * 같은 이름의 그룹이 계정별로 따로 존재할 수 있어서 [accountName] 을 함께 들고 다닌다.
 */
data class ContactGroup(
    val id: Long,
    val title: String,
    val accountName: String = "",
    /** 그룹이 속한 계정 종류. 연락처는 그룹과 같은 계정에 있어야 그룹에 들어간다. */
    val accountType: String = "",
    val memberCount: Int = 0
)

/**
 * 그룹 목록을 사용자에게 보여줄 형태로 다듬는다.
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라 JVM 단위 테스트로 검증한다.
 */
object ContactGroups {

    /** 이름이 없는 그룹과 같은 id 의 중복을 걷어내고 이름순으로 정렬한다. */
    fun normalize(raw: List<ContactGroup>): List<ContactGroup> {
        val seen = HashSet<Long>()
        return raw
            .filter { it.title.isNotBlank() }
            .filter { seen.add(it.id) }
            .sortedWith(compareBy({ it.title }, { it.accountName }))
    }

    /**
     * 목록에 표시할 이름. 같은 이름이 둘 이상 있을 때만 계정 이름을 덧붙여 구별한다.
     * 멤버 수는 아는 경우에만 괄호로 보여준다.
     */
    fun labels(groups: List<ContactGroup>): List<String> {
        val duplicated = groups.groupingBy { it.title }.eachCount()
            .filterValues { it > 1 }
            .keys

        return groups.map { group ->
            buildString {
                append(group.title)
                if (group.title in duplicated && group.accountName.isNotBlank()) {
                    append(" (").append(group.accountName).append(')')
                }
                if (group.memberCount > 0) {
                    append(" · ").append(group.memberCount).append("명")
                }
            }
        }
    }

    /** 선택한 그룹들을 "영업팀, 거래처" 처럼 한 줄로 요약한다. */
    fun summary(groups: List<ContactGroup>, selectedIds: Set<Long>): String =
        groups.filter { it.id in selectedIds }.joinToString(", ") { it.title }

    /**
     * 한 연락처는 한 계정에만 속하므로 그룹도 한 계정 것만 쓸 수 있다.
     * 첫 번째 그룹의 계정을 기준으로 삼고 다른 계정의 그룹은 걸러낸다.
     */
    fun sameAccount(groups: List<ContactGroup>): List<ContactGroup> {
        val first = groups.firstOrNull() ?: return emptyList()
        return groups.filter {
            it.accountName == first.accountName && it.accountType == first.accountType
        }
    }

    /** [accountName]/[accountType] 계정에 속한 그룹만 남긴다. */
    fun inAccount(
        groups: List<ContactGroup>,
        accountName: String?,
        accountType: String?
    ): List<ContactGroup> = groups.filter {
        it.accountName == accountName.orEmpty() && it.accountType == accountType.orEmpty()
    }
}
