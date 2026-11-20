package org.pycam.bizcard

import android.content.Context
import org.json.JSONObject

/** 내 명함 한 장을 앱 설정에 보관한다. */
class MyCardStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): MyCard {
        val raw = prefs.getString(KEY_CARD, null) ?: return MyCard()
        return try {
            val json = JSONObject(raw)
            MyCard(
                name = json.optString("name"),
                company = json.optString("company"),
                department = json.optString("department"),
                title = json.optString("title"),
                tagline = json.optString("tagline"),
                mobile = json.optString("mobile"),
                phone = json.optString("phone"),
                fax = json.optString("fax"),
                email = json.optString("email"),
                website = json.optString("website"),
                address = json.optString("address"),
                templateId = json.optString("templateId").ifBlank { CardTemplates.DEFAULT_ID },
                accentColor = json.optInt("accentColor")
            )
        } catch (e: Exception) {
            MyCard()
        }
    }

    fun save(card: MyCard) {
        val json = JSONObject().apply {
            put("name", card.name)
            put("company", card.company)
            put("department", card.department)
            put("title", card.title)
            put("tagline", card.tagline)
            put("mobile", card.mobile)
            put("phone", card.phone)
            put("fax", card.fax)
            put("email", card.email)
            put("website", card.website)
            put("address", card.address)
            put("templateId", card.templateId)
            put("accentColor", card.accentColor)
        }
        prefs.edit().putString(KEY_CARD, json.toString()).apply()
    }

    fun hasCard(): Boolean = !load().isEmpty

    private companion object {
        const val PREFS = "bizcard_local"
        const val KEY_CARD = "my_card"
    }
}

/** 마지막으로 고른 연락처 그룹을 기억해 다음 저장 때 미리 선택해 둔다. */
object GroupPrefs {

    private const val PREFS = "bizcard_local"
    private const val KEY_GROUPS = "last_group_ids"

    fun lastSelected(context: Context): Set<Long> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY_GROUPS, emptySet())
            .orEmpty()
            .mapNotNull { it.toLongOrNull() }
            .toSet()

    fun remember(context: Context, ids: Set<Long>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_GROUPS, ids.map { it.toString() }.toSet())
            .apply()
    }
}
