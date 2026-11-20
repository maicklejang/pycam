package org.pycam.bizcard

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.snackbar.Snackbar
import org.pycam.bizcard.databinding.ActivityMyCardBinding
import java.io.File
import java.io.FileOutputStream

/**
 * 내 명함을 만들고 보내는 화면.
 *
 * 템플릿과 강조색을 고르고 항목을 채우면 미리보기가 바로 바뀐다. 보내기는 vCard 와
 * 명함 그림 중에서 고를 수 있다.
 */
class MyCardActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMyCardBinding
    private lateinit var store: MyCardStore
    private lateinit var templateAdapter: TemplateAdapter

    private var templateId: String = CardTemplates.DEFAULT_ID
    private var accentColor: Int = 0

    private val handler = Handler(Looper.getMainLooper())
    private val refreshThumbnails = Runnable { templateAdapter.update(current()) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMyCardBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = MyCardStore(this)
        binding.toolbar.setNavigationOnClickListener { finish() }

        templateAdapter = TemplateAdapter { template ->
            templateId = template.id
            // 템플릿을 바꾸면 그 템플릿의 기본색으로 돌아간다.
            accentColor = 0
            buildAccentRow()
            refreshPreview(immediate = true)
        }
        binding.templateList.layoutManager =
            LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        binding.templateList.adapter = templateAdapter

        val saved = store.load()
        templateId = saved.templateId
        accentColor = saved.accentColor
        bind(saved)
        buildAccentRow()

        editTexts().forEach { field ->
            field.doAfterTextChanged { refreshPreview(immediate = false) }
        }

        binding.saveMyCardButton.setOnClickListener { saveCard() }
        binding.sendMyCardButton.setOnClickListener { askHowToSend() }

        refreshPreview(immediate = true)
    }

    override fun onDestroy() {
        handler.removeCallbacks(refreshThumbnails)
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 폼

    private fun editTexts(): List<EditText> = listOf(
        binding.myNameInput,
        binding.myCompanyInput,
        binding.myDepartmentInput,
        binding.myTitleInput,
        binding.myTaglineInput,
        binding.myMobileInput,
        binding.myPhoneInput,
        binding.myFaxInput,
        binding.myEmailInput,
        binding.myWebsiteInput,
        binding.myAddressInput
    )

    private fun bind(card: MyCard) {
        binding.myNameInput.setText(card.name)
        binding.myCompanyInput.setText(card.company)
        binding.myDepartmentInput.setText(card.department)
        binding.myTitleInput.setText(card.title)
        binding.myTaglineInput.setText(card.tagline)
        binding.myMobileInput.setText(card.mobile)
        binding.myPhoneInput.setText(card.phone)
        binding.myFaxInput.setText(card.fax)
        binding.myEmailInput.setText(card.email)
        binding.myWebsiteInput.setText(card.website)
        binding.myAddressInput.setText(card.address)
    }

    private fun current(): MyCard = MyCard(
        name = binding.myNameInput.textValue(),
        company = binding.myCompanyInput.textValue(),
        department = binding.myDepartmentInput.textValue(),
        title = binding.myTitleInput.textValue(),
        tagline = binding.myTaglineInput.textValue(),
        mobile = binding.myMobileInput.textValue(),
        phone = binding.myPhoneInput.textValue(),
        fax = binding.myFaxInput.textValue(),
        email = binding.myEmailInput.textValue(),
        website = binding.myWebsiteInput.textValue(),
        address = binding.myAddressInput.textValue(),
        templateId = templateId,
        accentColor = accentColor
    )

    private fun EditText.textValue(): String = text?.toString()?.trim().orEmpty()

    // ------------------------------------------------------------------ 미리보기

    /**
     * 큰 미리보기는 바로 다시 그리고, 템플릿 썸네일 6장은 입력이 멈춘 뒤에만 다시 그린다.
     * 글자를 칠 때마다 6장을 그리면 느려진다.
     */
    private fun refreshPreview(immediate: Boolean) {
        val card = current()
        binding.preview.setImageBitmap(CardRenderer.render(card, PREVIEW_WIDTH))

        handler.removeCallbacks(refreshThumbnails)
        if (immediate) {
            templateAdapter.update(card)
        } else {
            handler.postDelayed(refreshThumbnails, THUMBNAIL_DELAY_MS)
        }
    }

    /** 강조색 동그라미를 만든다. 첫 칸은 템플릿 기본색으로 되돌리는 칸이다. */
    private fun buildAccentRow() {
        binding.accentRow.removeAllViews()
        val size = (40 * resources.displayMetrics.density).toInt()
        val margin = (8 * resources.displayMetrics.density).toInt()
        val template = CardTemplates.byId(templateId)

        fun addSwatch(color: Int, value: Int, label: String) {
            val selected = accentColor == value
            val swatch = ImageView(this).apply {
                layoutParams = LinearLayout.LayoutParams(size, size).apply {
                    marginEnd = margin
                }
                contentDescription = label
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                    if (selected) setStroke((3 * resources.displayMetrics.density).toInt(), 0xFF1A1A1A.toInt())
                }
                setOnClickListener {
                    accentColor = value
                    buildAccentRow()
                    refreshPreview(immediate = true)
                }
            }
            binding.accentRow.addView(swatch)
        }

        addSwatch(template.accent, 0, getString(R.string.accent_default))
        CardTemplates.ACCENTS.forEachIndexed { index, color ->
            addSwatch(color, color, getString(R.string.accent_choice, index + 1))
        }
    }

    // ------------------------------------------------------------------ 저장·보내기

    private fun saveCard() {
        val card = current()
        if (card.isEmpty) {
            notify(getString(R.string.my_card_empty))
            return
        }
        store.save(card)
        notify(getString(R.string.my_card_saved))
    }

    private fun askHowToSend() {
        val card = current()
        if (card.isEmpty) {
            notify(getString(R.string.my_card_empty))
            return
        }
        // 보내는 순간의 내용을 그대로 저장해 둔다. 다음에 열면 이어서 쓸 수 있다.
        store.save(card)

        val options = arrayOf(
            getString(R.string.send_vcard),
            getString(R.string.send_image),
            getString(R.string.send_both)
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.action_send_my_card)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> send(card, vcard = true, image = false)
                    1 -> send(card, vcard = false, image = true)
                    else -> send(card, vcard = true, image = true)
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun send(card: MyCard, vcard: Boolean, image: Boolean) {
        val uris = ArrayList<Uri>()
        val outcome = runCatching {
            val shareDir = File(cacheDir, "shared").apply { mkdirs() }
            val safeName = card.displayName
                .replace(Regex("""[^\p{L}\p{N}._-]"""), "_")
                .take(40)
                .ifBlank { "my_card" }

            if (vcard) {
                val file = File(shareDir, "$safeName.vcf")
                file.writeText(card.toVCard(), Charsets.UTF_8)
                uris += FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            }
            if (image) {
                val file = File(shareDir, "$safeName.png")
                val bitmap = CardRenderer.render(card, CardTemplates.RENDER_WIDTH)
                try {
                    FileOutputStream(file).use { output ->
                        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                            error("이미지를 만들지 못했습니다")
                        }
                    }
                } finally {
                    bitmap.recycle()
                }
                uris += FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            }
        }

        outcome.onFailure { error ->
            notify(getString(R.string.my_card_send_failed, error.message ?: error.javaClass.simpleName))
            return
        }
        if (uris.isEmpty()) return

        val intent = if (uris.size == 1) {
            Intent(Intent.ACTION_SEND).apply {
                type = if (vcard) "text/x-vcard" else "image/png"
                putExtra(Intent.EXTRA_STREAM, uris.first())
            }
        } else {
            Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = "*/*"
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            }
        }
        intent.putExtra(Intent.EXTRA_SUBJECT, card.displayName)
        intent.putExtra(Intent.EXTRA_TEXT, card.displayName)
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        startActivity(Intent.createChooser(intent, getString(R.string.action_send_my_card)))
    }

    private fun notify(message: String) {
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    private companion object {
        const val PREVIEW_WIDTH = 900
        const val THUMBNAIL_DELAY_MS = 400L
    }
}
