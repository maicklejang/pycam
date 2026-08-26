package org.pycam.bizcard

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.google.android.material.snackbar.Snackbar
import org.pycam.bizcard.databinding.ActivityCaptureBinding

/** CameraX 로 명함을 촬영해 앱 내부 저장소에 JPEG 으로 남긴다. */
class CaptureActivity : AppCompatActivity() {

    private lateinit var binding: ActivityCaptureBinding
    private lateinit var store: CardStore

    private var imageCapture: ImageCapture? = null
    private var camera: androidx.camera.core.Camera? = null
    private var torchOn = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCaptureBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = CardStore(this)

        binding.closeButton.setOnClickListener { finish() }
        binding.shutterButton.setOnClickListener { takePhoto() }
        binding.flashButton.setOnClickListener { toggleTorch() }

        startCamera()
    }

    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val provider = try {
                providerFuture.get()
            } catch (e: Exception) {
                showError(getString(R.string.capture_failed))
                return@addListener
            }

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.preview.surfaceProvider)
            }
            val capture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setTargetRotation(binding.preview.display?.rotation ?: android.view.Surface.ROTATION_0)
                .build()

            try {
                provider.unbindAll()
                camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
                imageCapture = capture
                binding.flashButton.visibility =
                    if (camera?.cameraInfo?.hasFlashUnit() == true) View.VISIBLE else View.GONE
            } catch (e: Exception) {
                showError(getString(R.string.capture_failed))
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun toggleTorch() {
        val control = camera?.cameraControl ?: return
        torchOn = !torchOn
        control.enableTorch(torchOn)
        binding.flashButton.alpha = if (torchOn) 1f else 0.6f
    }

    private fun takePhoto() {
        val capture = imageCapture ?: return
        val file = store.newImageFile()

        binding.shutterButton.isEnabled = false
        binding.progress.visibility = View.VISIBLE

        capture.takePicture(
            ImageCapture.OutputFileOptions.Builder(file).build(),
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    setResult(
                        Activity.RESULT_OK,
                        Intent().putExtra(EXTRA_IMAGE_NAME, file.name)
                    )
                    finish()
                }

                override fun onError(exception: ImageCaptureException) {
                    file.delete()
                    binding.shutterButton.isEnabled = true
                    binding.progress.visibility = View.GONE
                    showError(getString(R.string.capture_failed))
                }
            }
        )
    }

    private fun showError(message: String) {
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    companion object {
        const val EXTRA_IMAGE_NAME = "image_name"
    }
}
