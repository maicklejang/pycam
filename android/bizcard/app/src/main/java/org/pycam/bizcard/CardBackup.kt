package org.pycam.bizcard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.Calendar
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * 명함 자료를 압축 파일 한 개로 내보내고, 다시 읽어 들인다.
 *
 * 담는 것은 스캔 기록(명함 사진 + 인식 결과)과 내 명함(설정 + 사진 + 회사 로고)이다.
 * 기기 주소록에 저장한 연락처는 주소록 쪽에 있으므로 여기서 다루지 않는다.
 *
 * 파일 모양은 [BackupPlan] 에 적어 두었다.
 */
class CardBackup(context: Context) {

    private val appContext = context.applicationContext
    private val cardStore = CardStore(appContext)
    private val myCardStore = MyCardStore(appContext)

    /** 복원할 압축 파일에 무엇이 들어 있는지. */
    data class Contents(
        val cards: List<BizCard>,
        val images: Int,
        val myCard: MyCard?,
        val hasMyPhoto: Boolean,
        val hasLogo: Boolean,
        /** 꺼내 둔 사진이 있는 임시 디렉터리. [apply] 나 [discard] 로 반드시 정리한다. */
        val staging: File
    ) {
        val hasMyCard: Boolean get() = myCard != null || hasMyPhoto || hasLogo
    }

    class BackupError(message: String) : Exception(message)

    // ------------------------------------------------------------------ 내보내기

    /**
     * [output] 에 백업 압축 파일을 쓴다. 스트림은 이 함수가 닫는다.
     * 오래 걸릴 수 있으므로 화면 스레드에서 부르지 않는다.
     */
    fun exportTo(output: OutputStream): BackupSummary {
        val cards = cardStore.load()
        val myCard = myCardStore.load()
        val hasPhoto = myCardStore.hasPhoto()
        val hasLogo = myCardStore.hasLogo()

        var images = 0
        ZipOutputStream(output.buffered()).use { zip ->
            zip.putNextEntry(ZipEntry(BackupPlan.ENTRY_MANIFEST))
            zip.write(manifest(cards, myCard, hasPhoto, hasLogo).toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            for (card in cards) {
                val name = BackupPlan.safeName(card.imageName) ?: continue
                val file = cardStore.imageFile(name)
                if (!file.exists() || file.length() == 0L) continue
                zip.putNextEntry(ZipEntry(BackupPlan.imageEntry(name)))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
                images++
            }

            if (hasPhoto) {
                zip.putNextEntry(ZipEntry(BackupPlan.ENTRY_MY_PHOTO))
                myCardStore.photoFile.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
            if (hasLogo) {
                zip.putNextEntry(ZipEntry(BackupPlan.ENTRY_MY_LOGO))
                myCardStore.logoFile.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }

        return BackupSummary(
            cards = cards.size,
            images = images,
            myCard = myCard.canSave(hasPhoto),
            logo = hasLogo
        )
    }

    private fun manifest(
        cards: List<BizCard>,
        myCard: MyCard,
        hasPhoto: Boolean,
        hasLogo: Boolean
    ): String {
        val array = JSONArray()
        cards.forEach { array.put(CardJson.toJson(it)) }
        return JSONObject().apply {
            put("app", APP_TAG)
            put("version", BackupPlan.VERSION)
            put("createdAt", System.currentTimeMillis())
            put("cards", array)
            if (myCard.canSave(hasPhoto) || hasLogo) put("myCard", MyCardJson.toJson(myCard))
            put("hasMyPhoto", hasPhoto)
            put("hasLogo", hasLogo)
        }.toString()
    }

    /** 오늘 날짜가 든 백업 파일 이름. */
    fun suggestedFileName(now: Calendar = Calendar.getInstance()): String = BackupPlan.fileName(
        now.get(Calendar.YEAR),
        now.get(Calendar.MONTH) + 1,
        now.get(Calendar.DAY_OF_MONTH),
        now.get(Calendar.HOUR_OF_DAY),
        now.get(Calendar.MINUTE)
    )

    // ------------------------------------------------------------------ 읽어 들이기

    /**
     * [input] 의 압축 파일을 읽어 임시 디렉터리에 풀어 둔다. 아직 앱 자료는 건드리지 않는다.
     * 무엇을 복원할지 사용자에게 보여 주고 [apply] 로 마무리한다. 스트림은 이 함수가 닫는다.
     */
    fun stage(input: InputStream): Contents {
        val staging = File(appContext.cacheDir, STAGING_DIR)
        staging.deleteRecursively()
        val imageDir = File(staging, "images").apply { mkdirs() }

        var manifest: String? = null
        var images = 0
        var total = 0L
        var hasPhoto = false
        var hasLogo = false

        try {
            ZipInputStream(input.buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    if (entry.isDirectory) {
                        zip.closeEntry()
                        continue
                    }
                    when {
                        entry.name == BackupPlan.ENTRY_MANIFEST -> {
                            manifest = zip.readBoundedText(MAX_MANIFEST_BYTES)
                        }

                        entry.name == BackupPlan.ENTRY_MY_PHOTO -> {
                            hasPhoto = zip.copyBounded(File(staging, BackupPlan.ENTRY_MY_PHOTO))
                        }

                        entry.name == BackupPlan.ENTRY_MY_LOGO -> {
                            hasLogo = zip.copyBounded(File(staging, BackupPlan.ENTRY_MY_LOGO))
                        }

                        else -> {
                            val name = BackupPlan.imageNameFrom(entry.name)
                            if (name != null && images < BackupPlan.MAX_IMAGES && total < MAX_TOTAL_BYTES) {
                                val target = File(imageDir, name)
                                if (zip.copyBounded(target)) {
                                    images++
                                    total += target.length()
                                }
                            }
                        }
                    }
                    zip.closeEntry()
                }
            }
        } catch (e: BackupError) {
            staging.deleteRecursively()
            throw e
        } catch (e: Exception) {
            staging.deleteRecursively()
            throw BackupError("압축 파일을 읽지 못했습니다")
        }

        val text = manifest
        if (text == null) {
            staging.deleteRecursively()
            throw BackupError("이 앱이 만든 백업 파일이 아닙니다")
        }

        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            staging.deleteRecursively()
            throw BackupError("백업 파일의 정보가 깨져 있습니다")
        }

        if (json.optInt("version", 1) > BackupPlan.VERSION) {
            staging.deleteRecursively()
            throw BackupError("더 새로운 버전에서 만든 백업 파일입니다. 앱을 새로 받아 주세요.")
        }

        val array = json.optJSONArray("cards") ?: JSONArray()
        val cards = (0 until array.length()).mapNotNull { index ->
            runCatching { CardJson.fromJson(array.getJSONObject(index)) }.getOrNull()
        }
        val myCard = json.optJSONObject("myCard")?.let { runCatching { MyCardJson.fromJson(it) }.getOrNull() }

        return Contents(
            cards = cards,
            images = images,
            myCard = myCard,
            hasMyPhoto = hasPhoto,
            hasLogo = hasLogo,
            staging = staging
        )
    }

    /**
     * 풀어 둔 자료를 실제로 들여온다. 스캔 기록은 **더하기만** 한다. 같은 사진을 가리키는
     * 항목은 나중에 저장된 쪽을 남기고, 기존 항목을 지우지 않는다.
     *
     * [restoreMyCard] 가 false 면 내 명함은 손대지 않는다.
     */
    fun apply(contents: Contents, restoreMyCard: Boolean): BackupSummary {
        try {
            val existing = cardStore.load()
            val merged = BackupPlan.merge(existing, contents.cards, CardStore.MAX_ENTRIES)
            val needed = BackupPlan.neededImages(merged)

            var copied = 0
            val imageDir = File(contents.staging, "images")
            imageDir.listFiles()?.forEach { file ->
                val name = BackupPlan.safeName(file.name) ?: return@forEach
                if (name !in needed) return@forEach
                val target = cardStore.imageFile(name)
                // 같은 이름의 사진이 이미 있으면 그대로 둔다. 같은 장이라 덮어쓸 이유가 없다.
                if (target.exists() && target.length() > 0L) return@forEach
                if (runCatching { file.copyTo(target, overwrite = true) }.isSuccess) copied++
            }

            // 기존에 없던 사진을 가리키는 항목만 "새로 들어온 기록" 으로 센다.
            val existingNames = existing.map { it.imageName }.toSet()
            val addedCards = contents.cards.count { it.imageName !in existingNames }
            cardStore.replaceAll(merged)

            var myCardRestored = false
            var logoRestored = false
            if (restoreMyCard) {
                val photo = File(contents.staging, BackupPlan.ENTRY_MY_PHOTO)
                if (photo.exists() && photo.length() > 0L) {
                    myCardStore.importPhoto(photo)
                }
                val logo = File(contents.staging, BackupPlan.ENTRY_MY_LOGO)
                if (logo.exists() && logo.length() > 0L) {
                    logoRestored = myCardStore.importLogo(logo)
                }
                contents.myCard?.let { card ->
                    myCardStore.save(card)
                    myCardRestored = true
                }
            }

            return BackupSummary(
                cards = addedCards,
                images = copied,
                myCard = myCardRestored,
                logo = logoRestored
            )
        } finally {
            contents.staging.deleteRecursively()
        }
    }

    fun discard(contents: Contents) {
        contents.staging.deleteRecursively()
    }

    // ------------------------------------------------------------------ 압축 항목 읽기

    /** 한 항목을 [target] 에 쓴다. 너무 크면 예외를 던진다. 썼으면 true. */
    private fun InputStream.copyBounded(target: File): Boolean {
        target.parentFile?.mkdirs()
        val buffer = ByteArray(BUFFER)
        var written = 0L
        target.outputStream().buffered().use { output ->
            while (true) {
                val read = read(buffer)
                if (read <= 0) break
                written += read
                if (written > BackupPlan.MAX_IMAGE_BYTES) {
                    throw BackupError("백업 파일 안의 사진이 너무 큽니다")
                }
                output.write(buffer, 0, read)
            }
        }
        if (written == 0L) {
            target.delete()
            return false
        }
        return true
    }

    /**
     * 한 항목을 글자로 읽는다. 너무 길면 예외를 던진다.
     *
     * 한글은 한 글자가 여러 바이트라 토막마다 글자로 바꾸면 경계에서 깨진다.
     * 바이트를 다 모은 뒤에 한 번에 바꾼다.
     */
    private fun InputStream.readBoundedText(limit: Int): String {
        val buffer = ByteArray(BUFFER)
        val bytes = ByteArrayOutputStream()
        while (true) {
            val read = read(buffer)
            if (read <= 0) break
            if (bytes.size() + read > limit) throw BackupError("백업 파일의 정보가 너무 큽니다")
            bytes.write(buffer, 0, read)
        }
        return bytes.toString("UTF-8")
    }

    private companion object {
        const val APP_TAG = "org.pycam.bizcard"
        const val STAGING_DIR = "restore"
        const val BUFFER = 64 * 1024
        const val MAX_MANIFEST_BYTES = 8 * 1024 * 1024
        const val MAX_TOTAL_BYTES = 1024L * 1024 * 1024
    }
}
