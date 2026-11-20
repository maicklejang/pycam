package org.pycam.bizcard

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.EditText
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.pycam.bizcard.databinding.ActivityReviewBinding
import java.io.File

/** OCR 결과를 사용자에게 확인·수정받고 기기 주소록에 반영한다. */
class ReviewActivity : AppCompatActivity() {

    private lateinit var binding: ActivityReviewBinding
    private lateinit var store: CardStore
    private lateinit var imageFile: File

    private val recognizer = CardRecognizer()
    private var rawText: String = ""
    private var savedAt: Long = 0L

    /** OCR 로 추정하거나 사용자가 고른 명함 영역. 잘라낼 것이 없으면 null. */
    private var pendingCrop: CardCrop.Box? = null
    private var sourceWidth: Int = 0
    private var sourceHeight: Int = 0
    private var alreadyCropped: Boolean = false

    /** 사용자가 직접 고른 영역. 있으면 이 영역 안에서만 글자를 읽는다. */
    private var manualRegion: ManualRegion? = null

    /** 기기 주소록의 그룹 목록과 사용자가 고른 그룹. */
    private var groups: List<ContactGroup> = emptyList()
    private var selectedGroupIds: MutableSet<Long> = linkedSetOf()

    private data class ManualRegion(val box: CardCrop.Box, val sourceWidth: Int, val sourceHeight: Int)

    private val requestContacts = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants[Manifest.permission.WRITE_CONTACTS] == true) {
            val knewGroups = groups.isNotEmpty()
            loadGroups()
            if (!knewGroups && groups.isNotEmpty()) {
                // 권한을 막 얻어 그룹이 있다는 걸 알게 됐다. 저장 전에 한 번 고르게 한다.
                showGroupDialog(saveAfter = true)
            } else {
                writeToContacts()
            }
        } else {
            notify(getString(R.string.permission_contacts_required))
        }
    }

    private val requestReadContacts = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted) {
            notify(getString(R.string.permission_contacts_required))
            return@registerForActivityResult
        }
        loadGroups()
        if (groups.isEmpty()) {
            notify(getString(R.string.group_empty))
        } else {
            showGroupDialog(saveAfter = false)
        }
    }

    private val cropLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val data = result.data ?: return@registerForActivityResult

        val width = data.getIntExtra(CropActivity.EXTRA_SOURCE_WIDTH, 0)
        val height = data.getIntExtra(CropActivity.EXTRA_SOURCE_HEIGHT, 0)
        if (width <= 0 || height <= 0) return@registerForActivityResult

        manualRegion = if (data.getBooleanExtra(CropActivity.EXTRA_WHOLE_IMAGE, false)) {
            // 사진 전체를 고른 것이라 잘라낼 것이 없다. 자동 감지로 돌아간다.
            null
        } else {
            ManualRegion(
                box = CardCrop.Box(
                    data.getIntExtra(CropActivity.EXTRA_LEFT, 0),
                    data.getIntExtra(CropActivity.EXTRA_TOP, 0),
                    data.getIntExtra(CropActivity.EXTRA_RIGHT, width),
                    data.getIntExtra(CropActivity.EXTRA_BOTTOM, height)
                ),
                sourceWidth = width,
                sourceHeight = height
            )
        }
        recognize(force = true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityReviewBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = CardStore(this)
        val imageName = intent.getStringExtra(EXTRA_IMAGE_NAME).orEmpty()
        imageFile = store.imageFile(imageName)
        if (imageName.isEmpty() || !imageFile.exists()) {
            notify(getString(R.string.capture_failed))
            finish()
            return
        }

        binding.toolbar.setNavigationOnClickListener { finish() }
        updateImagePreview()

        binding.saveButton.setOnClickListener { onSaveClicked() }
        binding.rescanButton.setOnClickListener { recognize(force = true) }
        binding.rawTextButton.setOnClickListener { showRawText() }
        binding.shareButton.setOnClickListener { shareVCard() }
        binding.selectRegionButton.setOnClickListener { openRegionPicker() }
        binding.groupButton.setOnClickListener { onGroupButtonClicked() }

        binding.cropSwitch.setOnCheckedChangeListener { _, _ -> updateImagePreview() }

        selectedGroupIds = GroupPrefs.lastSelected(this).toMutableSet()
        loadGroups()

        val existing = store.load().firstOrNull { it.imageName == imageName }
        if (existing != null) {
            savedAt = existing.savedAt
            rawText = existing.rawText
            alreadyCropped = existing.cropped
            bind(existing)
            showFields()
        } else {
            recognize(force = false)
        }
    }

    override fun onDestroy() {
        recognizer.close()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 인식

    private fun recognize(force: Boolean) {
        binding.fieldContainer.visibility = if (force) View.VISIBLE else View.GONE
        binding.progressRow.visibility = View.VISIBLE

        val manual = manualRegion

        lifecycleScope.launch {
            val result = try {
                withContext(Dispatchers.Default) {
                    if (manual == null) {
                        recognizer.recognize(this@ReviewActivity, android.net.Uri.fromFile(imageFile))
                    } else {
                        val cropped = ImageUtils.decodeCropped(
                            imageFile, manual.box, manual.sourceWidth, manual.sourceHeight, OCR_SIZE
                        ) ?: error("선택한 영역을 읽지 못했습니다")
                        try {
                            recognizer.recognize(cropped)
                        } finally {
                            cropped.recycle()
                        }
                    }
                }
            } catch (e: Exception) {
                binding.progressRow.visibility = View.GONE
                showFields()
                notify(getString(R.string.recognize_failed))
                return@launch
            }

            binding.progressRow.visibility = View.GONE
            showFields()

            if (manual == null) {
                sourceWidth = result.imageWidth
                sourceHeight = result.imageHeight
                pendingCrop = if (alreadyCropped) {
                    null
                } else {
                    CardCrop.detect(result.boxes, result.imageWidth, result.imageHeight)
                }
            } else {
                // 사용자가 고른 영역이 그대로 저장할 영역이 된다.
                sourceWidth = manual.sourceWidth
                sourceHeight = manual.sourceHeight
                pendingCrop = manual.box
            }
            updateCropControls()

            if (result.lines.isEmpty()) {
                notify(getString(R.string.recognize_empty))
                return@launch
            }

            rawText = result.lines.joinToString("\n")
            bind(BizCardParser.parseLines(result.lines))
        }
    }

    // ------------------------------------------------------------------ 명함 영역

    /** 영역을 직접 고르는 화면을 띄운다. 자동 감지 결과가 있으면 그 사각형으로 시작한다. */
    private fun openRegionPicker() {
        val manual = manualRegion
        val box = manual?.box ?: pendingCrop
        val width = manual?.sourceWidth ?: sourceWidth
        val height = manual?.sourceHeight ?: sourceHeight
        cropLauncher.launch(CropActivity.intent(this, imageFile.name, box, width, height))
    }

    private fun updateCropControls() {
        val available = pendingCrop != null
        binding.cropSwitch.visibility = if (available) View.VISIBLE else View.GONE
        binding.cropSwitch.setText(
            if (manualRegion != null) R.string.crop_to_selection else R.string.crop_to_card
        )
        if (available && !binding.cropSwitch.isChecked) {
            // 상태가 바뀌면 리스너가 미리보기를 새로 그린다. 두 번 디코딩하지 않는다.
            binding.cropSwitch.isChecked = true
        } else {
            updateImagePreview()
        }
    }

    private fun cropEnabled(): Boolean =
        pendingCrop != null && binding.cropSwitch.isChecked

    /** 스위치 상태에 따라 원본 또는 명함 영역만 보여준다. */
    private fun updateImagePreview() {
        val box = pendingCrop
        val bitmap = if (box != null && binding.cropSwitch.isChecked) {
            ImageUtils.decodeCropped(imageFile, box, sourceWidth, sourceHeight, PREVIEW_SIZE)
                ?: ImageUtils.decodeScaled(imageFile, PREVIEW_SIZE)
        } else {
            ImageUtils.decodeScaled(imageFile, PREVIEW_SIZE)
        }
        binding.cardImage.setImageBitmap(bitmap)
    }

    private fun showFields() {
        binding.fieldContainer.visibility = View.VISIBLE
    }

    // ------------------------------------------------------------------ 그룹

    private fun loadGroups() {
        groups = ContactWriter.loadGroups(this)
        // 기억해 둔 그룹 중 지금도 남아 있는 것만 선택 상태로 둔다.
        val available = groups.map { it.id }.toSet()
        selectedGroupIds.retainAll(available)
        updateGroupRow()
    }

    private fun selectedGroups(): List<ContactGroup> = groups.filter { it.id in selectedGroupIds }

    private fun updateGroupRow() {
        binding.groupRow.visibility = if (groups.isEmpty()) View.GONE else View.VISIBLE
        val summary = ContactGroups.summary(groups, selectedGroupIds)
        binding.groupValue.text = summary.ifBlank { getString(R.string.group_none) }
    }

    private fun onGroupButtonClicked() {
        if (!ContactWriter.hasReadPermission(this)) {
            requestReadContacts.launch(Manifest.permission.READ_CONTACTS)
            return
        }
        if (groups.isEmpty()) loadGroups()
        if (groups.isEmpty()) {
            notify(getString(R.string.group_empty))
            return
        }
        showGroupDialog(saveAfter = false)
    }

    /** [saveAfter] 가 true 면 고르기를 마친 뒤 바로 주소록에 저장한다. */
    private fun showGroupDialog(saveAfter: Boolean) {
        val current = groups
        val labels = ContactGroups.labels(current).toTypedArray()
        val checked = current.map { it.id in selectedGroupIds }.toBooleanArray()

        AlertDialog.Builder(this)
            .setTitle(R.string.group_dialog_title)
            .setMultiChoiceItems(labels, checked) { _, which, isChecked ->
                checked[which] = isChecked
            }
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val picked = current.filterIndexed { index, _ -> checked[index] }
                // 연락처는 한 계정에만 속하므로 그룹도 한 계정 것만 고를 수 있다.
                val usable = ContactGroups.sameAccount(picked)
                selectedGroupIds = usable.map { it.id }.toMutableSet()
                GroupPrefs.remember(this, selectedGroupIds)
                updateGroupRow()
                if (usable.size < picked.size) notify(getString(R.string.group_one_account))
                if (saveAfter) writeToContacts()
            }
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                if (saveAfter) writeToContacts()
            }
            .show()
    }

    // ------------------------------------------------------------------ 폼

    private fun bind(card: BizCard) {
        binding.nameInput.setText(card.name)
        binding.companyInput.setText(card.company)
        binding.departmentInput.setText(card.department)
        binding.titleInput.setText(card.title)
        binding.mobileInput.setText(card.mobile)
        binding.phoneInput.setText(card.phone)
        binding.faxInput.setText(card.fax)
        binding.emailInput.setText(card.email)
        binding.websiteInput.setText(card.website)
        binding.addressInput.setText(card.address)
        binding.noteInput.setText(card.note)
        if (card.rawText.isNotBlank()) rawText = card.rawText
    }

    private fun collect(): BizCard = BizCard(
        name = binding.nameInput.textValue(),
        company = binding.companyInput.textValue(),
        title = binding.titleInput.textValue(),
        department = binding.departmentInput.textValue(),
        mobile = binding.mobileInput.textValue(),
        phone = binding.phoneInput.textValue(),
        fax = binding.faxInput.textValue(),
        email = binding.emailInput.textValue(),
        website = binding.websiteInput.textValue(),
        address = binding.addressInput.textValue(),
        note = binding.noteInput.textValue(),
        rawText = rawText,
        imageName = imageFile.name,
        savedAt = savedAt
    )

    private fun EditText.textValue(): String = text?.toString()?.trim().orEmpty()

    // ------------------------------------------------------------------ 저장

    private fun onSaveClicked() {
        if (collect().isEmpty) {
            notify(getString(R.string.nothing_to_save))
            return
        }
        if (ContactWriter.hasWritePermission(this)) {
            writeToContacts()
        } else {
            requestContacts.launch(
                arrayOf(Manifest.permission.WRITE_CONTACTS, Manifest.permission.READ_CONTACTS)
            )
        }
    }

    private fun writeToContacts() {
        val card = collect()
        binding.saveButton.isEnabled = false

        val cropBox = pendingCrop.takeIf { cropEnabled() }
        val chosenGroups = selectedGroups()

        lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                runCatching {
                    // 명함 영역만 남기고 파일을 덮어쓴 뒤, 그 이미지를 연락처 사진으로 쓴다.
                    val didCrop = cropBox != null &&
                        ImageUtils.cropInPlace(imageFile, cropBox, sourceWidth, sourceHeight)
                    val photo = ImageUtils.toContactPhoto(imageFile)
                    didCrop to ContactWriter.saveOrUpdate(this@ReviewActivity, card, photo, chosenGroups)
                }
            }
            binding.saveButton.isEnabled = true

            outcome.onSuccess { (didCrop, result) ->
                if (didCrop) {
                    alreadyCropped = true
                    pendingCrop = null
                    manualRegion = null
                    binding.cropSwitch.visibility = View.GONE
                    updateImagePreview()
                }
                savedAt = System.currentTimeMillis()
                store.save(card.copy(savedAt = savedAt, cropped = alreadyCropped))
                setResult(Activity.RESULT_OK)

                val base = when {
                    result.created -> getString(R.string.saved_new)
                    result.addedFields > 0 -> getString(R.string.saved_updated, result.addedFields)
                    else -> getString(R.string.saved_nothing_new)
                }
                // 실제로 적용된 그룹만 알려 준다. 계정이 달라 빠진 그룹은 포함하지 않는다.
                val applied = ContactGroups.summary(groups, result.appliedGroupIds)
                notify(
                    if (applied.isBlank()) base
                    else getString(R.string.saved_with_groups, base, applied)
                )
            }.onFailure { error ->
                notify(getString(R.string.save_failed, error.message ?: error.javaClass.simpleName))
            }
        }
    }

    // ------------------------------------------------------------------ 부가 기능

    private fun showRawText() {
        AlertDialog.Builder(this)
            .setTitle(R.string.raw_text_title)
            .setMessage(rawText.ifBlank { getString(R.string.recognize_empty) })
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun shareVCard() {
        val card = collect()
        if (card.isEmpty) {
            notify(getString(R.string.nothing_to_save))
            return
        }

        val shareDir = File(cacheDir, "shared").apply { mkdirs() }
        val safeName = card.displayName.replace(Regex("""[^\p{L}\p{N}._-]"""), "_").take(40)
        val vcfFile = File(shareDir, "${safeName.ifBlank { "card" }}.vcf")
        vcfFile.writeText(card.toVCard(), Charsets.UTF_8)

        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", vcfFile)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/x-vcard"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, getString(R.string.action_share_vcard)))
    }

    private fun notify(message: String) {
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    companion object {
        const val EXTRA_IMAGE_NAME = "image_name"
        private const val PREVIEW_SIZE = 1280

        /** 사용자가 고른 영역을 인식할 때 쓰는 비트맵 크기. */
        private const val OCR_SIZE = 2048
    }
}
