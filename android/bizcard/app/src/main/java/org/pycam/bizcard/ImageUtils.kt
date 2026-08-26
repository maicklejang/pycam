package org.pycam.bizcard

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max

object ImageUtils {

    /** EXIF 회전을 반영해서 최대 [maxSize] 픽셀로 축소한 비트맵을 읽는다. */
    fun decodeScaled(file: File, maxSize: Int): Bitmap? {
        if (!file.exists()) return null

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > maxSize * 2) {
            sample *= 2
        }

        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val decoded = BitmapFactory.decodeFile(file.absolutePath, options) ?: return null
        val scaled = scaleToFit(decoded, maxSize)
        return rotateByExif(file, scaled)
    }

    private fun scaleToFit(bitmap: Bitmap, maxSize: Int): Bitmap {
        val longest = max(bitmap.width, bitmap.height)
        if (longest <= maxSize) return bitmap
        val ratio = maxSize.toFloat() / longest
        val scaled = Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt().coerceAtLeast(1),
            (bitmap.height * ratio).toInt().coerceAtLeast(1),
            true
        )
        if (scaled != bitmap) bitmap.recycle()
        return scaled
    }

    private fun rotateByExif(file: File, bitmap: Bitmap): Bitmap {
        val degrees = try {
            when (ExifInterface(file.absolutePath)
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } catch (e: Exception) {
            0f
        }
        if (degrees == 0f) return bitmap

        val matrix = Matrix().apply { postRotate(degrees) }
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated != bitmap) bitmap.recycle()
        return rotated
    }

    /** 연락처 사진 데이터 행에 넣을 수 있도록 작게 압축한 JPEG 바이트. */
    fun toContactPhoto(file: File): ByteArray? {
        val bitmap = decodeScaled(file, CONTACT_PHOTO_SIZE) ?: return null
        return try {
            val stream = ByteArrayOutputStream()
            var quality = 90
            do {
                stream.reset()
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
                quality -= 15
            } while (stream.size() > MAX_CONTACT_PHOTO_BYTES && quality >= 30)
            stream.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    /**
     * [box] 로 잘라낸 미리보기 비트맵. [box] 는 [sourceWidth] x [sourceHeight] 좌표계
     * (= OCR 이 쓴 좌표계)의 값이며, 실제 디코딩 크기에 맞춰 비례 변환한다.
     */
    fun decodeCropped(file: File, box: CardCrop.Box, sourceWidth: Int, sourceHeight: Int, maxSize: Int): Bitmap? {
        val bitmap = decodeScaled(file, maxSize) ?: return null
        val cropped = crop(bitmap, box, sourceWidth, sourceHeight)
        if (cropped == null) {
            bitmap.recycle()
            return null
        }
        if (cropped != bitmap) bitmap.recycle()
        return cropped
    }

    /**
     * 명함 영역만 남기고 [file] 을 덮어쓴다. 성공하면 true.
     * 새로 쓴 JPEG 에는 회전 정보가 없으므로 EXIF 는 남기지 않는다.
     */
    fun cropInPlace(file: File, box: CardCrop.Box, sourceWidth: Int, sourceHeight: Int): Boolean {
        val cropped = decodeCropped(file, box, sourceWidth, sourceHeight, CROP_OUTPUT_SIZE) ?: return false

        // 원본을 바로 열어 쓰면 압축이 실패했을 때 명함 사진이 사라진다.
        // 임시 파일에 먼저 쓰고 성공한 경우에만 갈아 끼운다.
        val temporary = File(file.parentFile, file.name + ".crop")
        return try {
            val written = FileOutputStream(temporary).use { output ->
                cropped.compress(Bitmap.CompressFormat.JPEG, CROP_QUALITY, output)
            }
            if (!written || temporary.length() == 0L) {
                temporary.delete()
                return false
            }
            if (temporary.renameTo(file)) {
                true
            } else {
                // 같은 디렉터리 안이라 보통 성공하지만, 실패하면 복사로 대체한다.
                val copied = runCatching { temporary.copyTo(file, overwrite = true) }.isSuccess
                temporary.delete()
                copied
            }
        } catch (e: Exception) {
            temporary.delete()
            false
        } finally {
            cropped.recycle()
        }
    }

    private fun crop(bitmap: Bitmap, box: CardCrop.Box, sourceWidth: Int, sourceHeight: Int): Bitmap? {
        if (sourceWidth <= 0 || sourceHeight <= 0) return null
        val scaleX = bitmap.width.toFloat() / sourceWidth
        val scaleY = bitmap.height.toFloat() / sourceHeight

        val left = (box.left * scaleX).toInt().coerceIn(0, bitmap.width - 1)
        val top = (box.top * scaleY).toInt().coerceIn(0, bitmap.height - 1)
        val right = (box.right * scaleX).toInt().coerceIn(left + 1, bitmap.width)
        val bottom = (box.bottom * scaleY).toInt().coerceIn(top + 1, bitmap.height)

        val width = right - left
        val height = bottom - top
        if (width < MIN_CROP_PIXELS || height < MIN_CROP_PIXELS) return null
        if (width == bitmap.width && height == bitmap.height) return bitmap

        return try {
            Bitmap.createBitmap(bitmap, left, top, width, height)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private const val CROP_OUTPUT_SIZE = 2048
    private const val CROP_QUALITY = 92
    private const val MIN_CROP_PIXELS = 32
    private const val CONTACT_PHOTO_SIZE = 512
    private const val MAX_CONTACT_PHOTO_BYTES = 700 * 1024
}
