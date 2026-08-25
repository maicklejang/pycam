package io.github.maicklejang.docviewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Shows the docviewer web ui in a WebView and hands it the documents the user
 * opened from another app.
 *
 * The app has no internet permission: everything - unzipping the office file,
 * parsing its xml, drawing the page - happens inside the WebView, on the file
 * bytes this activity reads from the incoming content uri.
 */
public class MainActivity extends Activity {

    /** Documents larger than this are refused rather than held in memory twice. */
    private static final int MAX_BYTES = 64 * 1024 * 1024;
    private static final int PICK_REQUEST = 1;
    private static final String PAGE = "file:///android_asset/index.html";

    private final List<Uri> pending = new ArrayList<Uri>();
    private final Map<Integer, byte[]> loaded = new HashMap<Integer, byte[]>();
    private final Map<Integer, String> failures = new HashMap<Integer, String>();

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                                                           ViewGroup.LayoutParams.MATCH_PARENT));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);        // file:///android_asset still works
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        webView.setWebViewClient(new ViewClient());
        webView.setWebChromeClient(new ChromeClient());
        webView.addJavascriptInterface(new Bridge(), "AndroidHost");
        setContentView(webView);
        collect(getIntent());
        webView.loadUrl(PAGE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        collect(intent);
        notifyPage();
    }

    @Override
    public void onBackPressed() {
        // the page goes back to its file list first; a second press leaves the app
        webView.evaluateJavascript("window.docviewerBack ? window.docviewerBack() : false",
                                   new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (!"true".equals(value)) {
                    finish();
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != PICK_REQUEST) {
            super.onActivityResult(request, result, data);
            return;
        }
        if (fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        }
    }

    /** Collect every uri carried by an incoming intent. */
    private void collect(Intent intent) {
        if (intent == null) {
            return;
        }
        String action = intent.getAction();
        List<Uri> found = new ArrayList<Uri>();
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            if (intent.getData() != null) {
                found.add(intent.getData());
            }
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) {
                found.add(uri);
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) {
                for (int index = 0; index < uris.size(); index++) {
                    if (uris.get(index) != null) {
                        found.add(uris.get(index));
                    }
                }
            }
        }
        if (found.isEmpty()) {
            return;
        }
        synchronized (pending) {
            pending.addAll(found);
        }
    }

    private void notifyPage() {
        if (!pageReady) {
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(
                    "window.docviewerOpenPending && window.docviewerOpenPending()", null);
            }
        });
    }

    /** Read a document once and keep it until the page says it is done with it. */
    private byte[] bytesOf(int index) {
        synchronized (pending) {
            if (loaded.containsKey(index)) {
                return loaded.get(index);
            }
            if (index < 0 || index >= pending.size()) {
                return null;
            }
            Uri uri = pending.get(index);
            InputStream stream = null;
            try {
                stream = getContentResolver().openInputStream(uri);
                if (stream == null) {
                    failures.put(index, "파일을 열 수 없습니다.");
                    return null;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                int read;
                while ((read = stream.read(chunk)) > 0) {
                    if (buffer.size() + read > MAX_BYTES) {
                        failures.put(index, "파일이 너무 큽니다 (64MB 까지).");
                        return null;
                    }
                    buffer.write(chunk, 0, read);
                }
                byte[] data = buffer.toByteArray();
                loaded.put(index, data);
                return data;
            } catch (Exception error) {
                failures.put(index, "파일을 읽지 못했습니다: " + error.getMessage());
                return null;
            } finally {
                if (stream != null) {
                    try {
                        stream.close();
                    } catch (Exception ignored) {
                        // nothing useful to do while closing
                    }
                }
            }
        }
    }

    /** Display name of a document, with an extension the viewer can recognise. */
    private String nameOf(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            Cursor cursor = null;
            try {
                cursor = getContentResolver().query(uri, null, null, null, null);
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (column >= 0) {
                        name = cursor.getString(column);
                    }
                }
            } catch (Exception ignored) {
                name = null;
            } finally {
                if (cursor != null) {
                    cursor.close();
                }
            }
        }
        if (name == null || name.length() == 0) {
            name = uri.getLastPathSegment();
        }
        if (name == null || name.length() == 0) {
            name = "문서";
        }
        if (name.lastIndexOf('.') <= 0) {
            String extension = extensionFor(getContentResolver().getType(uri));
            if (extension != null) {
                name = name + extension;
            }
        }
        return name;
    }

    private static String extensionFor(String mime) {
        if (mime == null) {
            return null;
        }
        if (mime.equals("application/pdf")) {
            return ".pdf";
        }
        if (mime.endsWith("wordprocessingml.document")) {
            return ".docx";
        }
        if (mime.endsWith("spreadsheetml.sheet")) {
            return ".xlsx";
        }
        if (mime.endsWith("presentationml.presentation")) {
            return ".pptx";
        }
        if (mime.equals("text/csv") || mime.equals("text/comma-separated-values")) {
            return ".csv";
        }
        if (mime.startsWith("text/")) {
            return ".txt";
        }
        if (mime.equals("image/jpeg")) {
            return ".jpg";
        }
        if (mime.startsWith("image/")) {
            return "." + mime.substring("image/".length());
        }
        return null;
    }

    /** The page reads documents through this object; every method runs off the ui thread. */
    private class Bridge {

        @JavascriptInterface
        public void ready() {
            pageReady = true;
            notifyPage();
        }

        @JavascriptInterface
        public int count() {
            synchronized (pending) {
                return pending.size();
            }
        }

        @JavascriptInterface
        public String name(int index) {
            synchronized (pending) {
                if (index < 0 || index >= pending.size()) {
                    return "";
                }
                return nameOf(pending.get(index));
            }
        }

        @JavascriptInterface
        public int size(int index) {
            byte[] data = bytesOf(index);
            return data == null ? -1 : data.length;
        }

        @JavascriptInterface
        public String error(int index) {
            synchronized (pending) {
                String message = failures.get(index);
                return message == null ? "" : message;
            }
        }

        @JavascriptInterface
        public String chunk(int index, int offset, int length) {
            byte[] data = bytesOf(index);
            if (data == null || offset < 0 || offset >= data.length) {
                return "";
            }
            int end = Math.min(data.length, offset + length);
            return Base64.encodeToString(data, offset, end - offset, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void done() {
            synchronized (pending) {
                pending.clear();
                loaded.clear();
                failures.clear();
            }
        }
    }

    private class ViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url != null && url.startsWith("file:///android_asset/")) {
                return false;
            }
            // links inside a document open in the browser, never inside the viewer
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception error) {
                Toast.makeText(MainActivity.this, "이 링크를 열 수 있는 앱이 없습니다.",
                               Toast.LENGTH_SHORT).show();
            }
            return true;
        }
    }

    private class ChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams parameters) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            Intent intent = parameters.createIntent();
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            try {
                startActivityForResult(intent, PICK_REQUEST);
            } catch (ActivityNotFoundException error) {
                fileCallback = null;
                Toast.makeText(MainActivity.this, "파일을 고를 수 있는 앱이 없습니다.",
                               Toast.LENGTH_LONG).show();
                return false;
            }
            return true;
        }
    }
}
