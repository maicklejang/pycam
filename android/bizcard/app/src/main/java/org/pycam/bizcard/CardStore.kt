package org.pycam.bizcard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** 스캔한 명함 이미지와 추출 결과를 앱 내부 저장소에 보관한다. */
class CardStore(context: Context) {

    private val appContext = context.applicationContext
    private val indexFile = File(appContext.filesDir, "cards.json")

    val imageDir: File = File(appContext.filesDir, "cards").apply { mkdirs() }

    fun newImageFile(): File = File(imageDir, "card_${System.currentTimeMillis()}_${UUID.randomUUID()}.jpg")

    fun imageFile(name: String): File = File(imageDir, name)

    fun load(): List<BizCard> {
        if (!indexFile.exists()) return emptyList()
        return try {
            val array = JSONArray(indexFile.readText())
            (0 until array.length()).map { CardJson.fromJson(array.getJSONObject(it)) }
                .sortedByDescending { it.savedAt }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** 같은 이미지에 대한 항목이 있으면 갱신하고, 없으면 새로 추가한다. */
    fun save(card: BizCard) {
        val stamped = if (card.savedAt == 0L) card.copy(savedAt = System.currentTimeMillis()) else card
        val current = load().filterNot { it.imageName == stamped.imageName && stamped.imageName.isNotEmpty() }
        write(listOf(stamped) + current)
    }

    /** 백업에서 복원한 목록으로 전체를 갈아 끼운다. */
    fun replaceAll(cards: List<BizCard>) {
        write(cards)
    }

    fun delete(card: BizCard) {
        write(load().filterNot { it.imageName == card.imageName && it.savedAt == card.savedAt })
        if (card.imageName.isNotEmpty()) imageFile(card.imageName).delete()
    }

    private fun write(cards: List<BizCard>) {
        val array = JSONArray()
        cards.take(MAX_ENTRIES).forEach { array.put(CardJson.toJson(it)) }
        indexFile.writeText(array.toString())
    }

    companion object {
        const val MAX_ENTRIES = 500
    }
}

/** 스캔한 명함 한 장을 JSON 으로 옮긴다. 목록 파일과 백업 파일이 같은 형태를 쓴다. */
object CardJson {

    fun toJson(card: BizCard): JSONObject = JSONObject().apply {
        put("name", card.name)
        put("company", card.company)
        put("title", card.title)
        put("department", card.department)
        put("mobile", card.mobile)
        put("phone", card.phone)
        put("fax", card.fax)
        put("email", card.email)
        put("website", card.website)
        put("address", card.address)
        put("note", card.note)
        put("rawText", card.rawText)
        put("imageName", card.imageName)
        put("cropped", card.cropped)
        put("savedAt", card.savedAt)
    }

    fun fromJson(json: JSONObject): BizCard = BizCard(
        name = json.optString("name"),
        company = json.optString("company"),
        title = json.optString("title"),
        department = json.optString("department"),
        mobile = json.optString("mobile"),
        phone = json.optString("phone"),
        fax = json.optString("fax"),
        email = json.optString("email"),
        website = json.optString("website"),
        address = json.optString("address"),
        note = json.optString("note"),
        rawText = json.optString("rawText"),
        imageName = json.optString("imageName"),
        cropped = json.optBoolean("cropped"),
        savedAt = json.optLong("savedAt")
    )
}
