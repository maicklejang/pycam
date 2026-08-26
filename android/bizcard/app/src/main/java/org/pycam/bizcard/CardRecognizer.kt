package org.pycam.bizcard

import android.content.Context
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * ML Kit 온디바이스 텍스트 인식. 한국어 모델은 한글과 라틴 문자를 함께 인식하며,
 * 모델이 앱에 포함되어 있어 네트워크 없이 동작한다.
 */
class CardRecognizer {

    private val recognizer = TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())

    suspend fun recognize(context: Context, uri: Uri): List<String> {
        val image = InputImage.fromFilePath(context, uri)
        val text = suspendCancellableCoroutine<Text> { continuation ->
            recognizer.process(image)
                .addOnSuccessListener { result -> continuation.resume(result) }
                .addOnFailureListener { error -> continuation.resumeWithException(error) }
        }
        return toReadingOrderLines(text)
    }

    fun close() = recognizer.close()

    /**
     * ML Kit 은 블록 단위로 결과를 주기 때문에 명함처럼 좌우로 나뉜 레이아웃에서는
     * 순서가 뒤섞인다. 세로 위치로 정렬한 뒤 같은 행에 있는 조각을 하나의 줄로 합친다.
     */
    private fun toReadingOrderLines(text: Text): List<String> {
        data class Fragment(val value: String, val top: Int, val bottom: Int, val left: Int)

        val fragments = ArrayList<Fragment>()
        for (block in text.textBlocks) {
            for (line in block.lines) {
                val box = line.boundingBox ?: continue
                val value = line.text.trim()
                if (value.isNotEmpty()) {
                    fragments += Fragment(value, box.top, box.bottom, box.left)
                }
            }
        }
        if (fragments.isEmpty()) {
            return text.text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
        }

        fragments.sortWith(compareBy({ it.top }, { it.left }))
        val averageHeight = fragments.sumOf { it.bottom - it.top } / fragments.size
        val tolerance = (averageHeight * 0.6f).toInt().coerceAtLeast(4)

        val rows = ArrayList<MutableList<Fragment>>()
        for (fragment in fragments) {
            val center = (fragment.top + fragment.bottom) / 2
            val row = rows.lastOrNull()
            val rowCenter = row?.let { current -> current.sumOf { (it.top + it.bottom) / 2 } / current.size }
            if (row != null && rowCenter != null && kotlin.math.abs(center - rowCenter) <= tolerance) {
                row += fragment
            } else {
                rows += mutableListOf(fragment)
            }
        }

        return rows.map { row ->
            row.sortedBy { it.left }.joinToString("  ") { it.value }
        }
    }
}
