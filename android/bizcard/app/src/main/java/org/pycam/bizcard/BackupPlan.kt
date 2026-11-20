package org.pycam.bizcard

/**
 * 백업 파일(zip) 의 구조와, 복원할 때 기존 자료와 합치는 규칙.
 *
 * 압축 파일 안은 이렇게 생겼다.
 * ```
 * manifest.json          스캔 기록과 내 명함 정보 (JSON)
 * images/card_….jpg      스캔한 명함 사진
 * my_card.jpg            내 명함 사진 (사진 모드일 때만)
 * my_card_logo.png       내 명함에 넣은 회사 로고
 * ```
 *
 * 안드로이드 API 에 의존하지 않는 순수 Kotlin 이라 JVM 단위 테스트로 검증한다.
 */
object BackupPlan {

    const val VERSION = 1

    const val ENTRY_MANIFEST = "manifest.json"
    const val ENTRY_MY_PHOTO = "my_card.jpg"
    const val ENTRY_MY_LOGO = "my_card_logo.png"
    const val IMAGE_DIR = "images/"

    /** 한 번에 복원할 수 있는 최대 장수. 압축 파일이 터무니없이 크면 거기서 멈춘다. */
    const val MAX_IMAGES = 1000

    /** 사진 한 장의 최대 크기. 이보다 큰 항목은 사진이 아니라고 보고 건너뛴다. */
    const val MAX_IMAGE_BYTES = 20L * 1024 * 1024

    /** 압축 파일 안의 사진 항목 이름. */
    fun imageEntry(imageName: String): String = IMAGE_DIR + imageName

    /**
     * 압축 파일 항목 이름에서 사진 파일 이름을 꺼낸다. 쓸 수 없는 이름이면 null.
     *
     * 남이 만든 압축 파일을 열 수도 있으니 `images/../…` 처럼 바깥으로 빠져나가는
     * 이름은 받지 않는다.
     */
    fun imageNameFrom(entry: String): String? {
        if (!entry.startsWith(IMAGE_DIR)) return null
        return safeName(entry.removePrefix(IMAGE_DIR))
    }

    /**
     * 파일 이름으로 써도 안전한지 본다. 디렉터리를 거슬러 올라가거나 경로를 담고 있으면 null.
     * 알파벳·숫자·점·밑줄·붙임표만 받는다. 앱이 만드는 이름(`card_<시각>_<uuid>.jpg`)은 모두 통과한다.
     */
    fun safeName(name: String): String? {
        if (name.isEmpty() || name.length > 128) return null
        if (name == "." || name == "..") return null
        if (name.startsWith(".")) return null
        if (!name.all { it.isLetterOrDigit() && it.code < 128 || it == '.' || it == '_' || it == '-' }) return null
        if (name.contains("..")) return null
        return name
    }

    /**
     * 백업 파일 이름. 같은 날 여러 번 만들어도 분 단위로 구분된다.
     * 숫자 모양이 기기 언어에 따라 달라지지 않도록 로케일을 고정한다.
     */
    fun fileName(year: Int, month: Int, day: Int, hour: Int, minute: Int): String =
        String.format(
            java.util.Locale.US,
            "bizcard-backup-%04d%02d%02d-%02d%02d.zip",
            year, month, day, hour, minute
        )

    /**
     * 복원한 기록을 기존 기록과 합친다. 같은 사진을 가리키는 항목은 한 번만 남기고,
     * 그중 더 나중에 저장된 쪽을 쓴다. 사진 이름이 없는 항목은 서로 합칠 근거가 없어 그대로 둔다.
     *
     * 지우는 일은 없다. 복원은 더하기만 한다.
     */
    fun merge(existing: List<BizCard>, incoming: List<BizCard>, limit: Int = 500): List<BizCard> {
        val byImage = LinkedHashMap<String, BizCard>()
        val loose = ArrayList<BizCard>()

        for (card in existing + incoming) {
            val key = card.imageName
            if (key.isEmpty()) {
                loose += card
                continue
            }
            val previous = byImage[key]
            if (previous == null || card.savedAt >= previous.savedAt) {
                byImage[key] = card
            }
        }

        return (byImage.values + loose)
            .sortedByDescending { it.savedAt }
            .take(limit)
    }

    /**
     * 복원한 사진 중에서 실제로 꺼내 쓸 것만 고른다. 기록에 없는 사진은 쓸 데가 없다.
     */
    fun neededImages(cards: List<BizCard>): Set<String> =
        cards.mapNotNull { safeName(it.imageName) }.toSet()
}

/** 백업·복원 결과를 한 줄로 알려주기 위한 집계. */
data class BackupSummary(
    val cards: Int = 0,
    val images: Int = 0,
    val myCard: Boolean = false,
    val logo: Boolean = false
) {
    val isEmpty: Boolean get() = cards == 0 && images == 0 && !myCard && !logo
}
