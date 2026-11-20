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
    private var barcodeMode: String = BarcodeContent.MODE_NONE
    private var logoSpot: String = LogoPlacement.SPOT_NONE
    private var logoScale: Float = LogoPlacement.DEFAULT_SCALE

    /** 사진 모드의 미리보기. 사진이 바뀔 때만 다시 읽는다. */
    private var photoPreview: Bitmap? = null

    /** 명함에 얹을 회사 로고. 로고가 바뀔 때만 다시 읽는다. */
    private var logoPreview: Bitmap? = null

    /** 카메라 권한을 받은 뒤에 무엇을 찍을지. */
    private var captureTarget: CaptureTarget = CaptureTarget.PHOTO

    private enum class CaptureTarget { PHOTO, LOGO }

    /** [bind] 가 항목을 채우는 동안에는 미리보기를 다시 그리지 않는다. */
    private var bindingFields: Boolean = false

    private val handler = Handler(Looper.getMainLooper())
    private val refreshThumbnails = Runnable { templateAdapter.update(current(), logoPreview) }

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

        // 촬영본은 들여온 뒤 지운다. 스캔 기록에 올리지 않은 중간 파일이다.
        val captured = cardStore.imageFile(imageName)
        if (captureTarget == CaptureTarget.LOGO) importLogo(captured) else importPhoto(captured)
        captured.delete()
    }

    private val pickLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val temporary = copyToCache(uri)
        if (temporary == null) {
            notify(getString(R.string.my_card_photo_failed))
            return@registerForActivityResult
        }
        importPhoto(temporary)
        temporary.delete()
    }

    private val logoPickLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val temporary = copyToCache(uri)
        if (temporary == null) {
            notify(getString(R.string.my_card_logo_failed))
            return@registerForActivityResult
        }
        importLogo(temporary)
        temporary.delete()
    }

    /** 내 명함 사진에서 쓸 영역을 고르고 돌아왔을 때. */
    private val cropPhotoLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val box = cropResult(result) ?: return@registerForActivityResult
        val done = ImageUtils.cropInPlace(
            store.photoFile,
            box.first,
            box.second,
            box.third,
            Bitmap.CompressFormat.JPEG
        )
        if (!done) {
            notify(getString(R.string.my_card_crop_failed))
            return@registerForActivityResult
        }
        reloadPhotoPreview()
        refreshPreview(immediate = true)
        notify(getString(R.string.my_card_photo_cropped))
    }

    /** 회사 로고에서 쓸 영역을 고르고 돌아왔을 때. 투명한 부분을 살려야 해서 PNG 로 다시 쓴다. */
    private val cropLogoLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val box = cropResult(result) ?: return@registerForActivityResult
        val done = ImageUtils.cropInPlace(
            store.logoFile,
            box.first,
            box.second,
            box.third,
            Bitmap.CompressFormat.PNG
        )
        if (!done) {
            notify(getString(R.string.my_card_crop_failed))
            return@registerForActivityResult
        }
        reloadLogoPreview()
        refreshPreview(immediate = true)
        notify(getString(R.string.my_card_photo_cropped))
    }

    /** 영역 고르기 화면이 돌려준 결과. 고르지 않았거나 그림 전체면 null. */
    private fun cropResult(
        result: androidx.activity.result.ActivityResult
    ): Triple<CardCrop.Box, Int, Int>? {
        if (result.resultCode != Activity.RESULT_OK) return null
        val data = result.data ?: return null
        if (data.getBooleanExtra(CropActivity.EXTRA_WHOLE_IMAGE, false)) return null
        val width = data.getIntExtra(CropActivity.EXTRA_SOURCE_WIDTH, 0)
        val height = data.getIntExtra(CropActivity.EXTRA_SOURCE_HEIGHT, 0)
        if (width <= 0 || height <= 0) return null
        val box = CardCrop.Box(
            data.getIntExtra(CropActivity.EXTRA_LEFT, 0),
            data.getIntExtra(CropActivity.EXTRA_TOP, 0),
            data.getIntExtra(CropActivity.EXTRA_RIGHT, width),
            data.getIntExtra(CropActivity.EXTRA_BOTTOM, height)
        )
        return Triple(box, width, height)
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
        barcodeMode = BarcodeContent.normalizeMode(saved.barcodeMode)
        logoSpot = LogoPlacement.normalizeSpot(saved.logoSpot)
        logoScale = LogoPlacement.normalizeScale(saved.logoScale)
        if (usePhoto) reloadPhotoPreview()
        if (store.hasLogo()) reloadLogoPreview()
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

        binding.barcodeGroup.check(barcodeButtonFor(barcodeMode))
        binding.barcodeGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            barcodeMode = barcodeModeFor(checkedId)
            applyBarcodeControls()
            refreshPreview(immediate = true)
        }

        binding.logoSpotGroup.check(logoSpotButtonFor(logoSpot))
        binding.logoSpotGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            logoSpot = logoSpotFor(checkedId)
            refreshPreview(immediate = true)
            val moved = logoSpot == LogoPlacement.SPOT_BOTTOM_RIGHT &&
                current().logoSpotFor(store.hasLogo()) != LogoPlacement.SPOT_BOTTOM_RIGHT
            if (moved) notify(getString(R.string.my_card_logo_moved))
        }

        binding.logoScaleSlider.value = sliderValue(logoScale)
        binding.logoScaleSlider.addOnChangeListener { _, value, _ ->
            logoScale = LogoPlacement.normalizeScale(value / 100f)
            refreshPreview(immediate = false)
        }

        editTexts().forEach { field ->
            field.doAfterTextChanged { refreshPreview(immediate = false) }
        }

        binding.pickScanButton.setOnClickListener { pickFromScans() }
        binding.capturePhotoButton.setOnClickListener { startCapture(CaptureTarget.PHOTO) }
        binding.galleryPhotoButton.setOnClickListener {
            pickLauncher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            )
        }
        binding.editPhotoButton.setOnClickListener { editPhotoRegion() }
        binding.deletePhotoButton.setOnClickListener { confirmDeletePhoto() }

        binding.logoPickButton.setOnClickListener {
            logoPickLauncher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            )
        }
        binding.logoCaptureButton.setOnClickListener { startCapture(CaptureTarget.LOGO) }
        binding.logoEditButton.setOnClickListener { editLogoRegion() }
        binding.logoClearBgButton.setOnClickListener { clearLogoBackground() }
        binding.logoDeleteButton.setOnClickListener { deleteLogo() }
        binding.showQrButton.setOnClickListener { showBarcode() }

        binding.saveMyCardButton.setOnClickListener { saveCard() }
        binding.sendMyCardButton.setOnClickListener { askHowToSend() }

        applyMode()
        applyLogoControls()
        applyBarcodeControls()
        refreshPreview(immediate = true)
    }

    override fun onDestroy() {
        handler.removeCallbacks(refreshThumbnails)
        BarcodeRenderer.clearCache()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 토글 값 옮기기

    private fun barcodeButtonFor(mode: String): Int = when (mode) {
        BarcodeContent.MODE_CONTACT -> R.id.barcodeContactButton
        BarcodeContent.MODE_LINK -> R.id.barcodeLinkButton
        else -> R.id.barcodeNoneButton
    }

    private fun barcodeModeFor(buttonId: Int): String = when (buttonId) {
        R.id.barcodeContactButton -> BarcodeContent.MODE_CONTACT
        R.id.barcodeLinkButton -> BarcodeContent.MODE_LINK
        else -> BarcodeContent.MODE_NONE
    }

    private fun logoSpotButtonFor(spot: String): Int = when (spot) {
        LogoPlacement.SPOT_TOP_RIGHT -> R.id.logoSpotTopRightButton
        LogoPlacement.SPOT_TOP_LEFT -> R.id.logoSpotTopLeftButton
        LogoPlacement.SPOT_BOTTOM_RIGHT -> R.id.logoSpotBottomRightButton
        else -> R.id.logoSpotNoneButton
    }

    private fun logoSpotFor(buttonId: Int): String = when (buttonId) {
        R.id.logoSpotTopRightButton -> LogoPlacement.SPOT_TOP_RIGHT
        R.id.logoSpotTopLeftButton -> LogoPlacement.SPOT_TOP_LEFT
        R.id.logoSpotBottomRightButton -> LogoPlacement.SPOT_BOTTOM_RIGHT
        else -> LogoPlacement.SPOT_NONE
    }

    /** 슬라이더는 백분율 정수로 다룬다. 소수점으로 두면 간격이 어긋나 예외가 난다. */
    private fun sliderValue(scale: Float): Float {
        val percent = Math.round(LogoPlacement.normalizeScale(scale) * 100f)
        val snapped = ((percent - SLIDER_MIN + 1) / SLIDER_STEP) * SLIDER_STEP + SLIDER_MIN
        return snapped.coerceIn(SLIDER_MIN, SLIDER_MAX).toFloat()
    }

    // ------------------------------------------------------------------ 모드

    /** 고른 모드에 따라 템플릿 영역과 사진 영역을 바꿔 보여준다. */
    private fun applyMode() {
        val hasPhoto = store.hasPhoto()
        binding.templateSection.visibility = if (usePhoto) View.GONE else View.VISIBLE
        binding.photoSection.visibility = if (usePhoto) View.VISIBLE else View.GONE
        binding.photoHint.visibility = if (usePhoto && !hasPhoto) View.VISIBLE else View.GONE
        // 사진을 아직 고르지 않았으면 다듬을 것도 지울 것도 없다.
        val photoTools = if (usePhoto && hasPhoto) View.VISIBLE else View.GONE
        binding.editPhotoButton.visibility = photoTools
        binding.deletePhotoButton.visibility = photoTools
    }

    /** 로고가 있을 때만 다듬기·자리·크기를 보여준다. */
    private fun applyLogoControls() {
        val visibility = if (store.hasLogo()) View.VISIBLE else View.GONE
        binding.logoEditRow.visibility = visibility
        binding.logoDeleteButton.visibility = visibility
        binding.logoSpotLabel.visibility = visibility
        binding.logoSpotScroll.visibility = visibility
        binding.logoSizeLabel.visibility = visibility
        binding.logoScaleSlider.visibility = visibility
    }

    /** 링크 모드일 때만 주소 입력칸을 보여준다. */
    private fun applyBarcodeControls() {
        binding.barcodeTextLayout.visibility =
            if (barcodeMode == BarcodeContent.MODE_LINK) View.VISIBLE else View.GONE
    }

    private fun startCapture(target: CaptureTarget) {
        captureTarget = target
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

    /** 갤러리에서 고른 그림을 임시 파일로 받아 둔다. 실패하면 null. */
    private fun copyToCache(uri: Uri): File? {
        val temporary = File(cacheDir, "my_card_source")
        val copied = runCatching {
            contentResolver.openInputStream(uri)?.use { input ->
                temporary.outputStream().use { output -> input.copyTo(output) }
            } != null
        }.getOrDefault(false)

        if (!copied || temporary.length() == 0L) {
            temporary.delete()
            return null
        }
        return temporary
    }

    /** 내 명함 사진에서 쓸 영역을 다시 고른다. */
    private fun editPhotoRegion() {
        if (!store.hasPhoto()) {
            notify(getString(R.string.my_card_need_photo))
            return
        }
        cropPhotoLauncher.launch(
            CropActivity.localIntent(this, CropActivity.SOURCE_MY_PHOTO)
        )
    }

    private fun confirmDeletePhoto() {
        if (!store.hasPhoto()) return
        AlertDialog.Builder(this)
            .setMessage(R.string.my_card_delete_photo_confirm)
            .setPositiveButton(R.string.action_delete) { _, _ ->
                store.deletePhoto()
                photoPreview = null
                applyMode()
                refreshPreview(immediate = true)
                notify(getString(R.string.my_card_photo_deleted))
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ------------------------------------------------------------------ 회사 로고

    /** [source] 를 회사 로고로 들여온다. 처음 넣을 때는 오른쪽 위에 놓아 둔다. */
    private fun importLogo(source: File): Boolean {
        if (!store.importLogo(source)) {
            notify(getString(R.string.my_card_logo_failed))
            return false
        }
        reloadLogoPreview()
        if (logoSpot == LogoPlacement.SPOT_NONE) {
            logoSpot = LogoPlacement.SPOT_TOP_RIGHT
            binding.logoSpotGroup.check(logoSpotButtonFor(logoSpot))
        }
        applyLogoControls()
        refreshPreview(immediate = true)
        notify(getString(R.string.my_card_logo_imported))
        return true
    }

    private fun editLogoRegion() {
        if (!store.hasLogo()) {
            notify(getString(R.string.my_card_logo_need))
            return
        }
        cropLogoLauncher.launch(
            CropActivity.localIntent(this, CropActivity.SOURCE_MY_LOGO)
        )
    }

    private fun clearLogoBackground() {
        if (!store.hasLogo()) {
            notify(getString(R.string.my_card_logo_need))
            return
        }
        if (!store.removeLogoBackground()) {
            notify(getString(R.string.my_card_logo_bg_failed))
            return
        }
        reloadLogoPreview()
        refreshPreview(immediate = true)
        notify(getString(R.string.my_card_logo_bg_done))
    }

    private fun deleteLogo() {
        if (!store.hasLogo()) return
        AlertDialog.Builder(this)
            .setMessage(R.string.my_card_logo_delete_confirm)
            .setPositiveButton(R.string.action_delete) { _, _ ->
                store.deleteLogo()
                logoPreview = null
                logoSpot = LogoPlacement.SPOT_NONE
                binding.logoSpotGroup.check(logoSpotButtonFor(logoSpot))
                applyLogoControls()
                refreshPreview(immediate = true)
                notify(getString(R.string.my_card_logo_deleted))
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ------------------------------------------------------------------ QR 코드

    /** QR 을 크게 띄운다. 상대가 그 자리에서 찍어 갈 수 있다. */
    private fun showBarcode() {
        val card = current()
        val payload = BarcodeContent.payload(card)
        if (payload.isNullOrBlank()) {
            notify(getString(R.string.my_card_barcode_empty))
            return
        }
        if (BarcodeContent.isTooLong(payload)) {
            notify(getString(R.string.my_card_barcode_long))
            return
        }
        val image = BarcodeRenderer.render(payload, QR_DIALOG_SIZE)
        if (image == null) {
            notify(getString(R.string.my_card_barcode_failed))
            return
        }

        val view = layoutInflater.inflate(R.layout.dialog_qr, null)
        view.findViewById<ImageView>(R.id.qrImage).setImageBitmap(image)
        view.findViewById<android.widget.TextView>(R.id.qrCaption).text = getString(
            if (card.barcodeMode == BarcodeContent.MODE_LINK) {
                R.string.my_card_barcode_dialog_link
            } else {
                R.string.my_card_barcode_dialog_contact
            }
        )

        AlertDialog.Builder(this)
            .setTitle(R.string.my_card_barcode_title)
            .setView(view)
            .setPositiveButton(android.R.string.ok, null)
            .setNeutralButton(R.string.my_card_barcode_share) { _, _ -> shareBarcode(card, payload) }
            .show()
    }

    /** QR 그림만 따로 보낸다. 명함을 띄워 둘 수 없는 자리에서 쓴다. */
    private fun shareBarcode(card: MyCard, payload: String) {
        val image = BarcodeRenderer.render(payload, QR_SHARE_SIZE)
        if (image == null) {
            notify(getString(R.string.my_card_barcode_failed))
            return
        }
        val outcome = runCatching {
            val shareDir = File(cacheDir, "shared").apply { mkdirs() }
            val file = File(shareDir, "${safeFileName(card)}_qr.png")
            FileOutputStream(file).use { output ->
                if (!image.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                    error("이미지를 만들지 못했습니다")
                }
            }
            FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        }
        val uri = outcome.getOrElse { error ->
            notify(getString(R.string.my_card_send_failed, error.message ?: error.javaClass.simpleName))
            return
        }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, card.displayName)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, getString(R.string.my_card_barcode_share)))
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
        binding.myAddressInput,
        binding.barcodeTextInput
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
        binding.barcodeTextInput.setText(card.barcodeText)
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
        usePhoto = usePhoto,
        barcodeMode = barcodeMode,
        barcodeText = binding.barcodeTextInput.textValue(),
        logoSpot = logoSpot,
        logoScale = logoScale
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

        binding.preview.setImageBitmap(CardRenderer.render(card, PREVIEW_WIDTH, logoPreview))
        handler.removeCallbacks(refreshThumbnails)
        if (immediate) {
            templateAdapter.update(card, logoPreview)
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

    /** 회사 로고를 다시 읽어 캐시에 올린다. 명함 가로의 절반도 되지 않게 들어가므로 작게 읽는다. */
    private fun reloadLogoPreview() {
        logoPreview = ImageUtils.decodeScaled(store.logoFile, LOGO_PREVIEW_WIDTH)
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
            val safeName = safeFileName(card)

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
                    val bitmap = CardRenderer.render(card, CardTemplates.RENDER_WIDTH, logoPreview)
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

    /** 보낼 파일 이름. 이름에 쓸 수 없는 글자는 밑줄로 바꾼다. */
    private fun safeFileName(card: MyCard): String = card.displayName
        .replace(Regex("""[^\p{L}\p{N}._-]"""), "_")
        .take(40)
        .ifBlank { "my_card" }

    private fun notify(message: String) {
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    private companion object {
        const val PREVIEW_WIDTH = 900
        const val THUMBNAIL_DELAY_MS = 400L

        /** 명함에 얹을 로고를 읽어 둘 크기. */
        const val LOGO_PREVIEW_WIDTH = 480

        /** 크게 띄워 보여 주는 QR 의 한 변. */
        const val QR_DIALOG_SIZE = 720

        /** 그림으로 보낼 QR 의 한 변. */
        const val QR_SHARE_SIZE = 1024

        const val SLIDER_MIN = 10
        const val SLIDER_MAX = 40
        const val SLIDER_STEP = 2
    }
}
