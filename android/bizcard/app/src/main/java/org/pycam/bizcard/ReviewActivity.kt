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

    /** OCR 로 추정한 명함 영역. 이미 잘려 있거나 잘라낼 것이 없으면 null. */
    private var pendingCrop: CardCrop.Box? = null
    private var sourceWidth: Int = 0
    private var sourceHeight: Int = 0
    private var alreadyCropped: Boolean = false

    private val requestContacts = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants[Manifest.permission.WRITE_CONTACTS] == true) {
            writeToContacts()
        } else {
            notify(getString(R.string.permission_contacts_required))
        }
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

        binding.cropSwitch.setOnCheckedChangeListener { _, _ -> updateImagePreview() }

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

        lifecycleScope.launch {
            val result = try {
                withContext(Dispatchers.Default) {
                    recognizer.recognize(this@ReviewActivity, android.net.Uri.fromFile(imageFile))
                }
            } catch (e: Exception) {
                binding.progressRow.visibility = View.GONE
                showFields()
                notify(getString(R.string.recognize_failed))
                return@launch
            }

            binding.progressRow.visibility = View.GONE
            showFields()

            if (result.lines.isEmpty()) {
                notify(getString(R.string.recognize_empty))
                return@launch
            }

            sourceWidth = result.imageWidth
            sourceHeight = result.imageHeight
            pendingCrop = if (alreadyCropped) {
                null
            } else {
                CardCrop.detect(result.boxes, result.imageWidth, result.imageHeight)
            }
            updateCropControls()

            rawText = result.lines.joinToString("\n")
            bind(BizCardParser.parseLines(result.lines))
        }
    }

    // ------------------------------------------------------------------ 명함 영역

    private fun updateCropControls() {
        val available = pendingCrop != null
        binding.cropSwitch.visibility = if (available) View.VISIBLE else View.GONE
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

        lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                runCatching {
                    // 명함 영역만 남기고 파일을 덮어쓴 뒤, 그 이미지를 연락처 사진으로 쓴다.
                    val didCrop = cropBox != null &&
                        ImageUtils.cropInPlace(imageFile, cropBox, sourceWidth, sourceHeight)
                    val photo = ImageUtils.toContactPhoto(imageFile)
                    didCrop to ContactWriter.saveOrUpdate(this@ReviewActivity, card, photo)
                }
            }
            binding.saveButton.isEnabled = true

            outcome.onSuccess { (didCrop, result) ->
                if (didCrop) {
                    alreadyCropped = true
                    pendingCrop = null
                    binding.cropSwitch.visibility = View.GONE
                    updateImagePreview()
                }
                savedAt = System.currentTimeMillis()
                store.save(card.copy(savedAt = savedAt, cropped = alreadyCropped))
                setResult(Activity.RESULT_OK)
                notify(
                    when {
                        result.created -> getString(R.string.saved_new)
                        result.addedFields > 0 -> getString(R.string.saved_updated, result.addedFields)
                        else -> getString(R.string.saved_nothing_new)
                    }
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
    }
}
