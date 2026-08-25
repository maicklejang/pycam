package io.github.maicklejang.docviewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
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
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Shows the docviewer web ui in a WebView and hands it the documents the user
 * opened from another app.
 *
 * The app has no internet permission: unzipping the office file, parsing its
 * xml and drawing the page all happen inside the WebView, on bytes this
 * activity reads from the incoming content uri.  Pdf files are the exception -
 * android's WebView cannot display them, so {@link PdfRenderer} draws the pages
 * here and the page shows the resulting images.
 */
public class MainActivity extends Activity {

    /** Documents larger than this are refused rather than held in memory twice. */
    private static final int MAX_BYTES = 64 * 1024 * 1024;
    /** How many documents keep their bytes around for paging through a pdf. */
    private static final int KEEP_LOADED = 3;
    private static final int MAX_PAGE_WIDTH = 2400;
    private static final int PICK_REQUEST = 1;
    private static final String PAGE = "file:///android_asset/index.html";

    private final Map<Integer, Document> documents = new LinkedHashMap<Integer, Document>();
    private final List<Integer> queue = new ArrayList<Integer>();
    private final Object lock = new Object();

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private boolean pageReady;
    private int nextId = 1;

    private PdfRenderer pdfRenderer;
    private ParcelFileDescriptor pdfDescriptor;
    private File pdfFile;

    /** One document the user asked to open. */
    private static class Document {
        Uri uri;
        String name;
        String mime;
        byte[] bytes;
        String error;
    }

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
    protected void onDestroy() {
        closePdf();
        super.onDestroy();
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

    /** Queue every uri carried by an incoming intent. */
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
        synchronized (lock) {
            for (int index = 0; index < found.size(); index++) {
                Document document = new Document();
                document.uri = found.get(index);
                document.mime = typeOf(document.uri);
                document.name = nameOf(document.uri, document.mime);
                int id = nextId++;
                documents.put(Integer.valueOf(id), document);
                queue.add(Integer.valueOf(id));
            }
            trim();
        }
    }

    /** Keep only the most recent documents in memory. */
    private void trim() {
        List<Integer> ids = new ArrayList<Integer>(documents.keySet());
        for (int index = 0; index < ids.size() - KEEP_LOADED; index++) {
            Integer id = ids.get(index);
            if (queue.contains(id)) {
                continue;
            }
            documents.remove(id);
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

    /** Read a document once; the bytes stay until an older document is evicted. */
    private byte[] bytesOf(int id) {
        synchronized (lock) {
            Document document = documents.get(Integer.valueOf(id));
            if (document == null) {
                return null;
            }
            if (document.bytes != null) {
                return document.bytes;
            }
            InputStream stream = null;
            try {
                stream = getContentResolver().openInputStream(document.uri);
                if (stream == null) {
                    document.error = "파일을 열 수 없습니다. 다른 앱에서 다시 열어 주세요.";
                    return null;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                int read;
                while ((read = stream.read(chunk)) > 0) {
                    if (buffer.size() + read > MAX_BYTES) {
                        document.error = "파일이 너무 큽니다 (64MB 까지).";
                        return null;
                    }
                    buffer.write(chunk, 0, read);
                }
                document.bytes = buffer.toByteArray();
                if (document.bytes.length == 0) {
                    document.error = "파일이 비어 있습니다.";
                    return null;
                }
                return document.bytes;
            } catch (Exception error) {
                document.error = "파일을 읽지 못했습니다: " + error;
                return null;
            } catch (OutOfMemoryError error) {
                document.error = "메모리가 부족해 이 파일을 열 수 없습니다.";
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

    private String typeOf(Uri uri) {
        String mime = null;
        try {
            mime = getContentResolver().getType(uri);
        } catch (Exception ignored) {
            mime = null;
        }
        return mime == null ? "" : mime;
    }

    /** Display name of a document, with an extension the viewer can recognise. */
    private String nameOf(Uri uri, String mime) {
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
            String extension = extensionFor(mime);
            if (extension != null) {
                name = name + extension;
            }
        }
        return name;
    }

    private static String extensionFor(String mime) {
        if (mime == null || mime.length() == 0) {
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

    // -- pdf ---------------------------------------------------------------

    /** Open a pdf with android's renderer and return its page count. */
    private int openPdf(int id) {
        byte[] data = bytesOf(id);
        if (data == null) {
            return -1;
        }
        synchronized (lock) {
            closePdf();
            try {
                pdfFile = File.createTempFile("view", ".pdf", getCacheDir());
                FileOutputStream out = new FileOutputStream(pdfFile);
                try {
                    out.write(data);
                } finally {
                    out.close();
                }
                pdfDescriptor = ParcelFileDescriptor.open(pdfFile,
                                                          ParcelFileDescriptor.MODE_READ_ONLY);
                pdfRenderer = new PdfRenderer(pdfDescriptor);
                return pdfRenderer.getPageCount();
            } catch (Exception error) {
                closePdf();
                return -1;
            }
        }
    }

    private String renderPdfPage(int number, int width) {
        synchronized (lock) {
            if (pdfRenderer == null || number < 0 || number >= pdfRenderer.getPageCount()) {
                return "";
            }
            Bitmap bitmap = null;
            PdfRenderer.Page page = null;
            try {
                page = pdfRenderer.openPage(number);
                int target = Math.max(320, Math.min(width, MAX_PAGE_WIDTH));
                int height = Math.max(1, target * page.getHeight() / page.getWidth());
                bitmap = Bitmap.createBitmap(target, height, Bitmap.Config.ARGB_8888);
                bitmap.eraseColor(Color.WHITE);
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out);
                return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            } catch (Exception error) {
                return "";
            } catch (OutOfMemoryError error) {
                return "";
            } finally {
                if (page != null) {
                    page.close();
                }
                if (bitmap != null) {
                    bitmap.recycle();
                }
            }
        }
    }

    private void closePdf() {
        synchronized (lock) {
            try {
                if (pdfRenderer != null) {
                    pdfRenderer.close();
                }
                if (pdfDescriptor != null) {
                    pdfDescriptor.close();
                }
            } catch (Exception ignored) {
                // the renderer is going away anyway
            }
            pdfRenderer = null;
            pdfDescriptor = null;
            if (pdfFile != null) {
                pdfFile.delete();
                pdfFile = null;
            }
        }
    }

    /** Hand a document to another app - used when the viewer cannot show it. */
    private void openElsewhere(int id) {
        Uri uri;
        String mime;
        synchronized (lock) {
            Document document = documents.get(Integer.valueOf(id));
            if (document == null) {
                return;
            }
            uri = document.uri;
            mime = document.mime;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mime == null || mime.length() == 0 ? "*/*" : mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(Intent.createChooser(intent, "다른 앱으로 열기"));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "이 파일을 열 수 있는 다른 앱이 없습니다.", Toast.LENGTH_LONG).show();
        }
    }

    /** The page talks to the app through this object; every method runs off the ui thread. */
    private class Bridge {

        @JavascriptInterface
        public void ready() {
            pageReady = true;
            notifyPage();
        }

        @JavascriptInterface
        public int count() {
            synchronized (lock) {
                return queue.size();
            }
        }

        @JavascriptInterface
        public int id(int position) {
            synchronized (lock) {
                if (position < 0 || position >= queue.size()) {
                    return -1;
                }
                return queue.get(position).intValue();
            }
        }

        @JavascriptInterface
        public String name(int id) {
            synchronized (lock) {
                Document document = documents.get(Integer.valueOf(id));
                return document == null ? "" : document.name;
            }
        }

        @JavascriptInterface
        public String mime(int id) {
            synchronized (lock) {
                Document document = documents.get(Integer.valueOf(id));
                return document == null ? "" : document.mime;
            }
        }

        @JavascriptInterface
        public int size(int id) {
            byte[] data = bytesOf(id);
            return data == null ? -1 : data.length;
        }

        @JavascriptInterface
        public String error(int id) {
            synchronized (lock) {
                Document document = documents.get(Integer.valueOf(id));
                return document == null || document.error == null ? "" : document.error;
            }
        }

        @JavascriptInterface
        public String chunk(int id, int offset, int length) {
            byte[] data = bytesOf(id);
            if (data == null || offset < 0 || offset >= data.length) {
                return "";
            }
            int end = Math.min(data.length, offset + length);
            return Base64.encodeToString(data, offset, end - offset, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void done() {
            synchronized (lock) {
                queue.clear();
                trim();
            }
        }

        @JavascriptInterface
        public int pdfOpen(int id) {
            return openPdf(id);
        }

        @JavascriptInterface
        public String pdfPage(int number, int width) {
            return renderPdfPage(number, width);
        }

        @JavascriptInterface
        public void pdfClose() {
            closePdf();
        }

        @JavascriptInterface
        public void openElsewhere(final int id) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.openElsewhere(id);
                }
            });
        }

        @JavascriptInterface
        public String describe() {
            return "android " + android.os.Build.VERSION.RELEASE
                + " / webview " + webViewVersion();
        }
    }

    private String webViewVersion() {
        try {
            String agent = webView.getSettings().getUserAgentString();
            int start = agent.indexOf("Chrome/");
            if (start < 0) {
                return "알 수 없음";
            }
            int end = agent.indexOf(' ', start);
            return agent.substring(start + 7, end < 0 ? agent.length() : end);
        } catch (Exception error) {
            return "알 수 없음";
        }
    }

    private class ViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url == null || url.startsWith("file:///android_asset/")
                    || url.startsWith("blob:") || url.startsWith("data:")) {
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
            // android matches on mime types only: keeping the page's extension list
            // would leave the picker empty on some phones
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
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
