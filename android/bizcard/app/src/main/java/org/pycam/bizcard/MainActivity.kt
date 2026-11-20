package org.pycam.bizcard

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.pycam.bizcard.databinding.ActivityMainBinding
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var store: CardStore
    private lateinit var myCardStore: MyCardStore
    private lateinit var adapter: CardAdapter

    /** 저장된 전체 목록. 화면에는 검색어로 걸러낸 결과만 보여준다. */
    private var allCards: List<BizCard> = emptyList()

    private val requestCamera = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchCapture() else notify(getString(R.string.permission_camera_required))
    }

    private val captureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val imageName = result.data?.getStringExtra(CaptureActivity.EXTRA_IMAGE_NAME)
        if (result.resultCode == Activity.RESULT_OK && imageName != null) {
            openReview(imageName)
        }
    }

    private val pickLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val target = store.newImageFile()
        val copied = runCatching {
            contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            } != null
        }.getOrDefault(false)

        if (copied) openReview(target.name) else notify(getString(R.string.capture_failed))
    }

    private val reviewLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { refresh() }

    /** 백업 파일을 저장할 자리를 사용자가 고른다. 앱이 저장 권한을 받을 필요가 없다. */
    private val createBackupLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
        if (uri != null) writeBackup(uri)
    }

    private val openBackupLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) readBackup(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = CardStore(this)
        myCardStore = MyCardStore(this)
        adapter = CardAdapter(
            store = store,
            onClick = { card -> openReview(card.imageName) },
            onDelete = { card -> confirmDelete(card) }
        )

        binding.cardList.layoutManager = LinearLayoutManager(this)
        binding.cardList.adapter = adapter

        binding.searchInput.doAfterTextChanged { applyFilter() }

        binding.myCardBanner.setOnClickListener { openMyCard() }

        binding.toolbar.inflateMenu(R.menu.main)
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_my_card -> {
                    openMyCard()
                    true
                }

                R.id.action_backup -> {
                    showBackupDialog()
                    true
                }

                else -> false
            }
        }

        binding.captureButton.setOnClickListener { startCapture() }
        binding.pickButton.setOnClickListener {
            pickLauncher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            )
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        allCards = store.load()
        applyFilter()
        refreshMyCardBanner()
    }

    private fun openMyCard() {
        startActivity(Intent(this, MyCardActivity::class.java))
    }

    /** 목록 맨 위의 내 명함 칸. 만들어 둔 명함이 있으면 그 모습과 이름을 보여준다. */
    private fun refreshMyCardBanner() {
        val card = myCardStore.load()
        val hasPhoto = myCardStore.hasPhoto()

        if (!card.canSave(hasPhoto)) {
            binding.myCardSubtitle.setText(R.string.my_card_banner_empty)
            binding.myCardThumb.setImageDrawable(null)
            return
        }

        val summary = listOf(card.name, card.company, card.roleLine)
            .filter { it.isNotBlank() }
            .joinToString(" · ")
        binding.myCardSubtitle.text = summary.ifBlank { card.displayName }

        val thumbnail = if (card.usePhoto) {
            ImageUtils.decodeScaled(myCardStore.photoFile, THUMBNAIL_WIDTH)
        } else {
            val logo = if (myCardStore.hasLogo()) {
                ImageUtils.decodeScaled(myCardStore.logoFile, THUMBNAIL_WIDTH)
            } else {
                null
            }
            CardRenderer.render(card, THUMBNAIL_WIDTH, logo)
        }
        if (thumbnail != null) {
            binding.myCardThumb.setImageBitmap(thumbnail)
        } else {
            binding.myCardThumb.setImageDrawable(null)
        }
    }

    /** 검색어를 적용해 목록·건수·빈 화면 안내를 갱신한다. */
    private fun applyFilter() {
        val query = binding.searchInput.text?.toString().orEmpty()
        val searching = query.isNotBlank()
        val visible = if (searching) CardSearch.filter(allCards, query) else allCards

        adapter.submit(visible)
        binding.searchLayout.visibility = if (allCards.isEmpty()) View.GONE else View.VISIBLE
        binding.resultCount.visibility =
            if (visible.isEmpty() || allCards.isEmpty()) View.GONE else View.VISIBLE
        binding.resultCount.text = getString(R.string.search_result_count, visible.size)

        binding.emptyView.visibility = if (visible.isEmpty()) View.VISIBLE else View.GONE
        binding.emptyTitle.setText(
            if (searching) R.string.search_empty_title else R.string.empty_title
        )
        binding.emptyMessage.setText(
            if (searching) R.string.search_empty_message else R.string.empty_message
        )
    }

    private fun startCapture() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) launchCapture() else requestCamera.launch(Manifest.permission.CAMERA)
    }

    private fun launchCapture() {
        captureLauncher.launch(Intent(this, CaptureActivity::class.java))
    }

    private fun openReview(imageName: String) {
        if (imageName.isEmpty()) return
        reviewLauncher.launch(
            Intent(this, ReviewActivity::class.java)
                .putExtra(ReviewActivity.EXTRA_IMAGE_NAME, imageName)
        )
    }

    private fun confirmDelete(card: BizCard) {
        AlertDialog.Builder(this)
            .setMessage("'${card.displayName}' 스캔 기록을 삭제할까요? 기기 주소록에 저장된 연락처는 지워지지 않습니다.")
            .setPositiveButton(R.string.action_delete) { _, _ ->
                store.delete(card)
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ------------------------------------------------------------------ 백업·복원

    private fun showBackupDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_backup, null)
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.backup_title)
            .setView(view)
            .setNegativeButton(android.R.string.cancel, null)
            .create()

        view.findViewById<View>(R.id.backupMakeButton).setOnClickListener {
            dialog.dismiss()
            startBackup(share = false)
        }
        view.findViewById<View>(R.id.backupShareButton).setOnClickListener {
            dialog.dismiss()
            startBackup(share = true)
        }
        view.findViewById<View>(R.id.backupRestoreButton).setOnClickListener {
            dialog.dismiss()
            openBackupLauncher.launch(BACKUP_MIME_TYPES)
        }
        dialog.show()
    }

    private fun startBackup(share: Boolean) {
        if (allCards.isEmpty() && !myCardStore.hasCard()) {
            notify(getString(R.string.backup_empty))
            return
        }
        val name = CardBackup(this).suggestedFileName()
        if (share) shareBackup(name) else createBackupLauncher.launch(name)
    }

    /** 사용자가 고른 자리에 백업 파일을 쓴다. */
    private fun writeBackup(uri: Uri) {
        lifecycleScope.launch {
            val waiting = waitingDialog(R.string.backup_working)
            val outcome = try {
                withContext(Dispatchers.IO) {
                    runCatching {
                        val stream = contentResolver.openOutputStream(uri)
                            ?: error("저장할 자리를 열지 못했습니다")
                        stream.use { CardBackup(this@MainActivity).exportTo(it) }
                    }
                }
            } finally {
                waiting.dismiss()
            }
            outcome
                .onSuccess { notify(getString(R.string.backup_done, it.cards, it.images)) }
                .onFailure { notify(getString(R.string.backup_failed, it.readableMessage())) }
        }
    }

    /** 백업 파일을 만들어 바로 다른 앱으로 보낸다. */
    private fun shareBackup(name: String) {
        lifecycleScope.launch {
            val waiting = waitingDialog(R.string.backup_working)
            val outcome = try {
                withContext(Dispatchers.IO) {
                    runCatching {
                        val shareDir = File(cacheDir, "shared").apply { mkdirs() }
                        val file = File(shareDir, name)
                        val summary = file.outputStream().use {
                            CardBackup(this@MainActivity).exportTo(it)
                        }
                        summary to FileProvider.getUriForFile(
                            this@MainActivity,
                            "$packageName.fileprovider",
                            file
                        )
                    }
                }
            } finally {
                waiting.dismiss()
            }
            outcome
                .onSuccess { (summary, uri) ->
                    notify(getString(R.string.backup_done, summary.cards, summary.images))
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "application/zip"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        putExtra(Intent.EXTRA_SUBJECT, name)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(
                        Intent.createChooser(intent, getString(R.string.backup_share_title))
                    )
                }
                .onFailure { notify(getString(R.string.backup_failed, it.readableMessage())) }
        }
    }

    /** 고른 백업 파일을 풀어 보고, 무엇을 복원할지 물어본다. */
    private fun readBackup(uri: Uri) {
        lifecycleScope.launch {
            val backup = CardBackup(this@MainActivity)
            val waiting = waitingDialog(R.string.backup_restoring)
            val outcome = try {
                withContext(Dispatchers.IO) {
                    runCatching {
                        val stream = contentResolver.openInputStream(uri)
                            ?: error("파일을 열지 못했습니다")
                        stream.use { backup.stage(it) }
                    }
                }
            } finally {
                waiting.dismiss()
            }
            outcome
                .onSuccess { contents -> confirmRestore(backup, contents) }
                .onFailure { notify(getString(R.string.restore_failed, it.readableMessage())) }
        }
    }

    private fun confirmRestore(backup: CardBackup, contents: CardBackup.Contents) {
        if (contents.cards.isEmpty() && contents.images == 0 && !contents.hasMyCard) {
            backup.discard(contents)
            notify(getString(R.string.restore_nothing))
            return
        }

        // 내 명함을 덮어쓸지는 물어본다. 이미 만들어 둔 것이 없으면 물을 것도 없다.
        val ask = contents.hasMyCard && myCardStore.hasCard()
        val message = buildString {
            append(getString(R.string.restore_confirm_message, contents.cards.size, contents.images))
            if (ask) append(getString(R.string.restore_my_card_question))
        }

        val builder = AlertDialog.Builder(this)
            .setTitle(R.string.restore_confirm_title)
            .setMessage(message)
            .setOnCancelListener { backup.discard(contents) }
            .setNegativeButton(android.R.string.cancel) { _, _ -> backup.discard(contents) }

        if (ask) {
            builder.setPositiveButton(R.string.restore_with_my_card) { _, _ ->
                applyRestore(backup, contents, restoreMyCard = true)
            }
            builder.setNeutralButton(R.string.restore_keep_my_card) { _, _ ->
                applyRestore(backup, contents, restoreMyCard = false)
            }
        } else {
            builder.setPositiveButton(R.string.restore_action) { _, _ ->
                applyRestore(backup, contents, restoreMyCard = contents.hasMyCard)
            }
        }
        builder.show()
    }

    private fun applyRestore(
        backup: CardBackup,
        contents: CardBackup.Contents,
        restoreMyCard: Boolean
    ) {
        lifecycleScope.launch {
            val waiting = waitingDialog(R.string.backup_restoring)
            val outcome = try {
                withContext(Dispatchers.IO) {
                    runCatching { backup.apply(contents, restoreMyCard) }
                }
            } finally {
                waiting.dismiss()
            }
            refresh()
            outcome
                .onSuccess { notify(getString(R.string.restore_done, it.cards, it.images)) }
                .onFailure { notify(getString(R.string.restore_failed, it.readableMessage())) }
        }
    }

    /** 오래 걸리는 일을 하는 동안 띄워 두는 안내. */
    private fun waitingDialog(message: Int): AlertDialog =
        AlertDialog.Builder(this)
            .setMessage(message)
            .setCancelable(false)
            .create()
            .also { it.show() }

    private fun Throwable.readableMessage(): String =
        message?.takeIf { it.isNotBlank() } ?: javaClass.simpleName

    private fun notify(message: String) {
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    private companion object {
        /** 백업 파일을 고를 때 보여줄 종류. 기기나 클라우드마다 알려주는 종류가 달라서 넉넉히 받는다. */
        val BACKUP_MIME_TYPES = arrayOf(
            "application/zip",
            "application/x-zip-compressed",
            "application/octet-stream"
        )

        /** 내 명함 칸의 썸네일 폭. 칸이 86dp 라 이 정도면 넉넉하다. */
        const val THUMBNAIL_WIDTH = 240
    }
}
