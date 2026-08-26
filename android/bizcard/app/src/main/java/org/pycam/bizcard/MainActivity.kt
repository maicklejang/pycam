package org.pycam.bizcard

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.snackbar.Snackbar
import org.pycam.bizcard.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var store: CardStore
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = CardStore(this)
        adapter = CardAdapter(
            store = store,
            onClick = { card -> openReview(card.imageName) },
            onDelete = { card -> confirmDelete(card) }
        )

        binding.cardList.layoutManager = LinearLayoutManager(this)
        binding.cardList.adapter = adapter

        binding.searchInput.doAfterTextChanged { applyFilter() }

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

    private fun notify(message: String) {
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }
}
