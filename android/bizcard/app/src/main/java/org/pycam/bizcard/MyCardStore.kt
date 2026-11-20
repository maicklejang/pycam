package org.pycam.bizcard

import android.content.Context
import android.graphics.Bitmap
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** 내 명함 한 장과, 사진으로 쓸 명함 이미지를 앱 내부에 보관한다. */
class MyCardStore(context: Context) {

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 사진 모드에서 쓰는 명함 이미지. 한 장만 둔다. */
    val photoFile: File = File(appContext.filesDir, "my_card.jpg")

    /** 템플릿 명함에 얹는 회사 로고. 배경을 지울 수 있어야 하므로 PNG 로 둔다. */
    val logoFile: File = File(appContext.filesDir, "my_card_logo.png")

    fun load(): MyCard {
        val raw = prefs.getString(KEY_CARD, null) ?: return MyCard()
        return try {
            MyCardJson.fromJson(JSONObject(raw))
        } catch (e: Exception) {
            MyCard()
        }
    }

    fun save(card: MyCard) {
        prefs.edit().putString(KEY_CARD, MyCardJson.toJson(card).toString()).apply()
    }

    fun hasCard(): Boolean {
        val card = load()
        return card.canSave(hasPhoto())
    }

    fun hasPhoto(): Boolean = photoFile.exists() && photoFile.length() > 0L

    fun hasLogo(): Boolean = logoFile.exists() && logoFile.length() > 0L

    /**
     * [source] 를 내 명함 사진으로 들여온다. EXIF 회전을 적용하고 크기를 줄여 다시 쓰므로
     * 원본이 어디서 왔든(촬영·갤러리·스캔 기록) 같은 형태로 남는다. 성공하면 true.
     *
     * 원본을 바로 덮어쓰지 않고 임시 파일에 먼저 써서, 실패했을 때 기존 사진을 잃지 않는다.
     */
    fun importPhoto(source: File): Boolean {
        val bitmap = ImageUtils.decodeScaled(source, PHOTO_SIZE) ?: return false
        val temporary = File(photoFile.parentFile, photoFile.name + ".tmp")
        return try {
            val written = FileOutputStream(temporary).use { output ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, PHOTO_QUALITY, output)
            }
            if (!written || temporary.length() == 0L) {
                temporary.delete()
                return false
            }
            if (temporary.renameTo(photoFile)) {
                true
            } else {
                val copied = runCatching { temporary.copyTo(photoFile, overwrite = true) }.isSuccess
                temporary.delete()
                copied
            }
        } catch (e: Exception) {
            temporary.delete()
            false
        } finally {
            bitmap.recycle()
        }
    }

    fun deletePhoto() {
        photoFile.delete()
    }

    /**
     * [source] 를 회사 로고로 들여온다. 로고는 명함 위에 얹히므로 투명한 부분을 살려야 해서
     * PNG 로 저장한다. 성공하면 true.
     */
    fun importLogo(source: File): Boolean {
        val bitmap = ImageUtils.decodeScaled(source, LOGO_SIZE) ?: return false
        return try {
            writeLogo(bitmap)
        } finally {
            bitmap.recycle()
        }
    }

    /**
     * 지금 로고에서 흰 배경을 지워 투명하게 만든다. 종이 명함에서 잘라낸 로고를 그대로
     * 얹으면 흰 네모가 보이는데, 이걸 없애 준다. 성공하면 true.
     */
    fun removeLogoBackground(): Boolean {
        val bitmap = ImageUtils.decodeScaled(logoFile, LOGO_SIZE) ?: return false
        // 지울 점이 없으면 읽어 온 비트맵을 그대로 돌려준다. 둘 중 어느 쪽이든 한 번만 버린다.
        val cleared = ImageUtils.clearWhiteBackground(bitmap)
        return try {
            writeLogo(cleared)
        } finally {
            cleared.recycle()
        }
    }

    fun deleteLogo() {
        logoFile.delete()
    }

    /** 로고를 임시 파일에 먼저 쓰고 성공한 경우에만 갈아 끼운다. */
    private fun writeLogo(bitmap: Bitmap): Boolean {
        val temporary = File(logoFile.parentFile, logoFile.name + ".tmp")
        return try {
            val written = FileOutputStream(temporary).use { output ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            }
            if (!written || temporary.length() == 0L) {
                temporary.delete()
                return false
            }
            if (temporary.renameTo(logoFile)) {
                true
            } else {
                val copied = runCatching { temporary.copyTo(logoFile, overwrite = true) }.isSuccess
                temporary.delete()
                copied
            }
        } catch (e: Exception) {
            temporary.delete()
            false
        }
    }

    private companion object {
        const val PREFS = "bizcard_local"
        const val KEY_CARD = "my_card"
        const val PHOTO_SIZE = 2048
        const val PHOTO_QUALITY = 92

        /** 로고는 명함 가로의 절반도 되지 않게 들어가므로 이 정도면 넉넉하다. */
        const val LOGO_SIZE = 512
    }
}

/** 내 명함 한 장을 JSON 으로 옮긴다. 앱 설정과 백업 파일이 같은 형태를 쓴다. */
object MyCardJson {

    fun toJson(card: MyCard): JSONObject = JSONObject().apply {
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
        put("usePhoto", card.usePhoto)
        put("barcodeMode", card.barcodeMode)
        put("barcodeText", card.barcodeText)
        put("logoSpot", card.logoSpot)
        put("logoScale", card.logoScale.toDouble())
    }

    fun fromJson(json: JSONObject): MyCard = MyCard(
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
        accentColor = json.optInt("accentColor"),
        usePhoto = json.optBoolean("usePhoto"),
        barcodeMode = BarcodeContent.normalizeMode(json.optString("barcodeMode")),
        barcodeText = json.optString("barcodeText"),
        logoSpot = LogoPlacement.normalizeSpot(json.optString("logoSpot")),
        logoScale = LogoPlacement.normalizeScale(
            json.optDouble("logoScale", LogoPlacement.DEFAULT_SCALE.toDouble()).toFloat()
        )
    )
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
