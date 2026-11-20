package org.pycam.bizcard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.snackbar.Snackbar
import org.pycam.bizcard.databinding.ActivityCropBinding

/**
 * 촬영한 사진에서 명함 영역을 손으로 골라내는 화면.
 *
 * 돌려주는 영역은 이 화면이 읽어들인 비트맵의 픽셀 좌표이고, 그 좌표계 크기를
 * [EXTRA_SOURCE_WIDTH]/[EXTRA_SOURCE_HEIGHT] 로 함께 알려준다.
 */
class CropActivity : AppCompatActivity() {

    private lateinit var binding: ActivityCropBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCropBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val store = CardStore(this)
        val imageName = intent.getStringExtra(EXTRA_IMAGE_NAME).orEmpty()
        val file = store.imageFile(imageName)
        val bitmap = if (imageName.isEmpty()) null else ImageUtils.decodeScaled(file, WORK_SIZE)

        if (bitmap == null) {
            Snackbar.make(binding.root, getString(R.string.capture_failed), Snackbar.LENGTH_LONG).show()
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }

        binding.toolbar.setNavigationOnClickListener { cancel() }
        binding.cropView.setBitmap(bitmap, initialBox(bitmap.width, bitmap.height))

        binding.resetButton.setOnClickListener { binding.cropView.reset() }
        binding.confirmButton.setOnClickListener { confirm(bitmap.width, bitmap.height) }
    }

    /** 호출한 쪽이 넘긴 영역을 지금 비트맵 좌표계로 옮긴다. */
    private fun initialBox(width: Int, height: Int): CardCrop.Box? {
        val sourceWidth = intent.getIntExtra(EXTRA_SOURCE_WIDTH, 0)
        val sourceHeight = intent.getIntExtra(EXTRA_SOURCE_HEIGHT, 0)
        if (sourceWidth <= 0 || sourceHeight <= 0) return null
        if (!intent.hasExtra(EXTRA_RIGHT)) return null

        val scaleX = width.toFloat() / sourceWidth
        val scaleY = height.toFloat() / sourceHeight
        val left = (intent.getIntExtra(EXTRA_LEFT, 0) * scaleX).toInt().coerceIn(0, width - 1)
        val top = (intent.getIntExtra(EXTRA_TOP, 0) * scaleY).toInt().coerceIn(0, height - 1)
        val right = (intent.getIntExtra(EXTRA_RIGHT, width) * scaleX).toInt().coerceIn(left + 1, width)
        val bottom = (intent.getIntExtra(EXTRA_BOTTOM, height) * scaleY).toInt().coerceIn(top + 1, height)
        return CardCrop.Box(left, top, right, bottom)
    }

    private fun confirm(width: Int, height: Int) {
        val box = binding.cropView.selectionBox()
        if (box == null) {
            cancel()
            return
        }
        setResult(
            Activity.RESULT_OK,
            Intent()
                .putExtra(EXTRA_LEFT, box.left)
                .putExtra(EXTRA_TOP, box.top)
                .putExtra(EXTRA_RIGHT, box.right)
                .putExtra(EXTRA_BOTTOM, box.bottom)
                .putExtra(EXTRA_SOURCE_WIDTH, width)
                .putExtra(EXTRA_SOURCE_HEIGHT, height)
                .putExtra(EXTRA_WHOLE_IMAGE, binding.cropView.isWholeImage())
        )
        finish()
    }

    private fun cancel() {
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    companion object {
        const val EXTRA_IMAGE_NAME = "image_name"
        const val EXTRA_LEFT = "left"
        const val EXTRA_TOP = "top"
        const val EXTRA_RIGHT = "right"
        const val EXTRA_BOTTOM = "bottom"
        const val EXTRA_SOURCE_WIDTH = "source_width"
        const val EXTRA_SOURCE_HEIGHT = "source_height"
        const val EXTRA_WHOLE_IMAGE = "whole_image"

        /** 영역을 고를 때 쓰는 비트맵 크기. 화면에 보여줄 만큼 크고 메모리는 넉넉하다. */
        private const val WORK_SIZE = 1600

        /** [box] 가 null 이면 자동 감지 결과 없이 시작한다. */
        fun intent(
            context: Context,
            imageName: String,
            box: CardCrop.Box?,
            sourceWidth: Int,
            sourceHeight: Int
        ): Intent = Intent(context, CropActivity::class.java).apply {
            putExtra(EXTRA_IMAGE_NAME, imageName)
            if (box != null && sourceWidth > 0 && sourceHeight > 0) {
                putExtra(EXTRA_LEFT, box.left)
                putExtra(EXTRA_TOP, box.top)
                putExtra(EXTRA_RIGHT, box.right)
                putExtra(EXTRA_BOTTOM, box.bottom)
                putExtra(EXTRA_SOURCE_WIDTH, sourceWidth)
                putExtra(EXTRA_SOURCE_HEIGHT, sourceHeight)
            }
        }
    }
}
