package org.pycam.bizcard

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
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
 * 두 가지로 만들 수 있다.
 * - **템플릿으로 만들기**: 템플릿과 강조색을 골라 글자로 그려낸다.
 * - **명함 사진 사용**: 이미 가지고 있는 종이 명함을 찍거나 스캔 기록에서 골라 그 사진을 쓴다.
 */
class MyCardActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMyCardBinding
    private lateinit var store: MyCardStore
    private lateinit var cardStore: CardStore
    private lateinit var templateAdapter: TemplateAdapter

    private var templateId: String = CardTemplates.DEFAULT_ID
    private var accentColor: Int = 0
    private var usePhoto: Boolean = false

    /** 사진 모드의 미리보기. 사진이 바뀔 때만 다시 읽는다. */
    private var photoPreview: Bitmap? = null

    /** [bind] 가 항목을 채우는 동안에는 미리보기를 다시 그리지 않는다. */
    private var bindingFields: Boolean = false

    private val handler = Handler(Looper.getMainLooper())
    private val refreshThumbnails = Runnable { templateAdapter.update(current()) }

    // ------------------------------------------------------------------ 사진 가져오기

    private val requestCamera = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchCapture() else notify(getString(R.string.permission_camera_required))
    }

    private val captureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val imageName = result.data?.getStringExtra(CaptureActivity.EXTRA_IMAGE_NAME)
        if (result.resultCode != Activity.RESULT_OK || imageName == null) return@registerForActivityResult

        // 촬영본은 내 명함으로 들여온 뒤 지운다. 스캔 기록에 올리지 않은 중간 파일이다.
        val captured = cardStore.imageFile(imageName)
        importPhoto(captured)
        captured.delete()
    }

    private val pickLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        importFromUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMyCardBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = MyCardStore(this)
        cardStore = CardStore(this)
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
        usePhoto = saved.usePhoto
        if (usePhoto) reloadPhotoPreview()
        bind(saved)
        buildAccentRow()

        binding.modeGroup.check(
            if (usePhoto) R.id.photoModeButton else R.id.templateModeButton
        )
        binding.modeGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            usePhoto = checkedId == R.id.photoModeButton
            applyMode()
            refreshPreview(immediate = true)
        }

        editTexts().forEach { field ->
            field.doAfterTextChanged { refreshPreview(immediate = false) }
        }

        binding.pickScanButton.setOnClickListener { pickFromScans() }
        binding.capturePhotoButton.setOnClickListener { startCapture() }
        binding.galleryPhotoButton.setOnClickListener {
            pickLauncher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            )
        }

        binding.saveMyCardButton.setOnClickListener { saveCard() }
        binding.sendMyCardButton.setOnClickListener { askHowToSend() }

        applyMode()
        refreshPreview(immediate = true)
    }

    override fun onDestroy() {
        handler.removeCallbacks(refreshThumbnails)
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 모드

    /** 고른 모드에 따라 템플릿 영역과 사진 영역을 바꿔 보여준다. */
    private fun applyMode() {
        binding.templateSection.visibility = if (usePhoto) View.GONE else View.VISIBLE
        binding.photoSection.visibility = if (usePhoto) View.VISIBLE else View.GONE
        binding.photoHint.visibility =
            if (usePhoto && !store.hasPhoto()) View.VISIBLE else View.GONE
    }

    private fun startCapture() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchCapture() else requestCamera.launch(Manifest.permission.CAMERA)
    }

    private fun launchCapture() {
        captureLauncher.launch(Intent(this, CaptureActivity::class.java))
    }

    /** 스캔해 둔 명함 중에서 내 명함으로 쓸 것을 고른다. */
    private fun pickFromScans() {
        val scans = cardStore.load().filter { it.imageName.isNotEmpty() }
        if (scans.isEmpty()) {
            notify(getString(R.string.my_card_scan_empty))
            return
        }

        val labels = scans.map { card ->
            listOf(card.displayName, card.displaySubtitle)
                .filter { it.isNotBlank() }
                .joinToString(" · ")
        }.toTypedArray()

        AlertDialog.Builder(this)
            .setTitle(R.string.my_card_pick_scan_title)
            .setItems(labels) { _, which ->
                val chosen = scans[which]
                if (importPhoto(cardStore.imageFile(chosen.imageName))) {
                    // 비어 있는 항목만 스캔 결과로 채운다. 입력해 둔 값은 건드리지 않는다.
                    bind(current().fillFrom(chosen))
                    refreshPreview(immediate = true)
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** 갤러리에서 고른 사진을 임시 파일로 받아 들여온다. */
    private fun importFromUri(uri: Uri) {
        val temporary = File(cacheDir, "my_card_source.jpg")
        val copied = runCatching {
            contentResolver.openInputStream(uri)?.use { input ->
                temporary.outputStream().use { output -> input.copyTo(output) }
            } != null
        }.getOrDefault(false)

        if (!copied) {
            notify(getString(R.string.my_card_photo_failed))
            return
        }
        importPhoto(temporary)
        temporary.delete()
    }

    /** [source] 를 내 명함 사진으로 삼는다. 성공하면 사진 모드로 전환한다. */
    private fun importPhoto(source: File): Boolean {
        if (!store.importPhoto(source)) {
            notify(getString(R.string.my_card_photo_failed))
            return false
        }
        usePhoto = true
        reloadPhotoPreview()
        if (binding.modeGroup.checkedButtonId == R.id.photoModeButton) {
            applyMode()
            refreshPreview(immediate = true)
        } else {
            // 버튼 상태가 바뀌면 리스너가 화면을 갱신한다. 두 번 그리지 않는다.
            binding.modeGroup.check(R.id.photoModeButton)
        }
        notify(getString(R.string.my_card_photo_imported))
        return true
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
        // 항목을 하나씩 채우면 리스너가 그만큼 미리보기를 다시 그린다. 한 번만 그리도록 막는다.
        bindingFields = true
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
        bindingFields = false
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
        accentColor = accentColor,
        usePhoto = usePhoto
    )

    private fun EditText.textValue(): String = text?.toString()?.trim().orEmpty()

    // ------------------------------------------------------------------ 미리보기

    /**
     * 큰 미리보기는 바로 다시 그리고, 템플릿 썸네일 6장은 입력이 멈춘 뒤에만 다시 그린다.
     * 글자를 칠 때마다 6장을 그리면 느려진다. 사진 모드에서는 썸네일을 그리지 않는다.
     */
    private fun refreshPreview(immediate: Boolean) {
        if (bindingFields) return
        val card = current()

        if (card.usePhoto) {
            val photo = photoPreview
            if (photo != null) {
                binding.preview.setImageBitmap(photo)
            } else {
                binding.preview.setImageDrawable(null)
            }
            binding.photoHint.visibility = if (photo == null) View.VISIBLE else View.GONE
            handler.removeCallbacks(refreshThumbnails)
            return
        }

        binding.preview.setImageBitmap(CardRenderer.render(card, PREVIEW_WIDTH))
        handler.removeCallbacks(refreshThumbnails)
        if (immediate) {
            templateAdapter.update(card)
        } else {
            handler.postDelayed(refreshThumbnails, THUMBNAIL_DELAY_MS)
        }
    }

    /**
     * 내 명함 사진을 다시 읽어 캐시에 올린다. 옛 비트맵은 재활용하지 않고 GC 에 맡긴다.
     * 화면이 아직 그리고 있을 수 있어서 recycle 하면 깨질 수 있다.
     */
    private fun reloadPhotoPreview() {
        photoPreview = ImageUtils.decodeScaled(store.photoFile, PREVIEW_WIDTH)
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
                    if (selected) {
                        setStroke((3 * resources.displayMetrics.density).toInt(), 0xFF1A1A1A.toInt())
                    }
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
        if (!card.canSave(store.hasPhoto())) {
            notify(getString(if (card.usePhoto) R.string.my_card_need_photo else R.string.my_card_empty))
            return
        }
        store.save(card)
        notify(getString(R.string.my_card_saved))
    }

    private fun askHowToSend() {
        val card = current()
        val hasPhoto = store.hasPhoto()
        if (!card.canSave(hasPhoto)) {
            notify(getString(if (card.usePhoto) R.string.my_card_need_photo else R.string.my_card_empty))
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
        if (vcard && !card.canSendVCard()) {
            notify(getString(R.string.my_card_need_fields))
            return
        }
        if (image && !card.canSendImage(store.hasPhoto())) {
            notify(getString(R.string.my_card_need_photo))
            return
        }

        val uris = ArrayList<Uri>()
        var imageType = "image/png"
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
                val file: File
                if (card.usePhoto) {
                    // 명함 사진은 그대로 보낸다. 다시 압축하지 않는다.
                    imageType = "image/jpeg"
                    file = File(shareDir, "$safeName.jpg")
                    store.photoFile.copyTo(file, overwrite = true)
                } else {
                    file = File(shareDir, "$safeName.png")
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
                type = if (vcard) "text/x-vcard" else imageType
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
