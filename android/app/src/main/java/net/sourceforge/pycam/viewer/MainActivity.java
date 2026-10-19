/* PyCAM Viewer - Android wrapper around the bundled web app.
 *
 * The whole viewer lives in the APK assets and is served through
 * WebViewAssetLoader, so the page runs on a real https origin (which web workers
 * and IndexedDB need) while staying completely offline.
 *
 * A file arriving through "open with" or "share" is copied into internal storage
 * and handed to the page as ?url=/shared/<name>, which the web app already knows
 * how to load.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
package net.sourceforge.pycam.viewer;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {

    private static final String TAG = "PyCAMViewer";
    private static final String DOMAIN = "appassets.androidplatform.net";
    private static final String INDEX = "https://" + DOMAIN + "/assets/index.html";

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private File sharedDir;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        sharedDir = new File(getFilesDir(), "shared");
        if (!sharedDir.exists() && !sharedDir.mkdirs()) {
            Log.w(TAG, "could not create the shared file directory");
        }

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/shared/",
                        new WebViewAssetLoader.InternalStoragePathHandler(this, sharedDir))
                .build();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(0xFF0E1117);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);

        webView.setWebViewClient(new LocalContentWebViewClient(assetLoader));

        // The page registers a service worker; its requests need the same routing.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                    new ServiceWorkerClientCompat() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                            return assetLoader.shouldInterceptRequest(request.getUrl());
                        }
                    });
        }

        webView.loadUrl(buildUrl(getIntent()));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        webView.loadUrl(buildUrl(intent));
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /** Index URL, with ?url= appended when the intent carried a file. */
    private String buildUrl(Intent intent) {
        Uri source = incomingFile(intent);
        if (source == null) {
            return INDEX;
        }
        String name = copyToSharedDir(source);
        if (name == null) {
            return INDEX;
        }
        return INDEX + "?url=" + Uri.encode("/shared/" + name, "/");
    }

    private Uri incomingFile(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            return intent.getData();
        }
        if (Intent.ACTION_SEND.equals(action)) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        return null;
    }

    /** Copies the shared content into internal storage, returns the file name. */
    private String copyToSharedDir(Uri source) {
        String name = sanitize(displayName(source));
        File target = new File(sharedDir, name);
        clearSharedDir();
        InputStream input = null;
        OutputStream output = null;
        try {
            input = getContentResolver().openInputStream(source);
            if (input == null) {
                return null;
            }
            output = new FileOutputStream(target);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
            output.flush();
            return name;
        } catch (IOException | SecurityException err) {
            Log.w(TAG, "could not read the shared file", err);
            return null;
        } finally {
            close(input);
            close(output);
        }
    }

    private void clearSharedDir() {
        File[] files = sharedDir.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (!file.delete()) {
                Log.w(TAG, "could not remove " + file.getName());
            }
        }
    }

    private String displayName(Uri source) {
        if ("file".equals(source.getScheme())) {
            return source.getLastPathSegment();
        }
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(source, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    return cursor.getString(column);
                }
            }
        } catch (RuntimeException err) {
            Log.w(TAG, "could not read the file name", err);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return source.getLastPathSegment();
    }

    /** Keeps the name usable as a URL path segment and preserves the extension. */
    private String sanitize(String name) {
        if (name == null || name.isEmpty()) {
            return "model.stl";
        }
        String cleaned = name.replaceAll("[^A-Za-z0-9._-]", "_");
        while (cleaned.startsWith(".")) {
            cleaned = cleaned.substring(1);
        }
        if (cleaned.isEmpty()) {
            return "model.stl";
        }
        if (cleaned.length() > 96) {
            int dot = cleaned.lastIndexOf('.');
            String extension = dot > 0 ? cleaned.substring(dot) : "";
            cleaned = cleaned.substring(0, 96 - extension.length()) + extension;
        }
        return cleaned;
    }

    private static void close(java.io.Closeable stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (IOException ignored) {
            // nothing useful left to do
        }
    }

    private static class LocalContentWebViewClient extends WebViewClientCompat {
        private final WebViewAssetLoader loader;

        LocalContentWebViewClient(WebViewAssetLoader loader) {
            this.loader = loader;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return loader.shouldInterceptRequest(request.getUrl());
        }
    }
}
