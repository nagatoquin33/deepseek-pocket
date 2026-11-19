package com.deepseek.pocket;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * DeepSeek 随身版 · Android 壳
 *
 * 设计：页面资源通过 shouldInterceptRequest 从 assets/www 提供，源为
 * https://appassets.local（安全上下文，麦克风可用）；页面直接带
 * Authorization 访问 https://api.deepseek.com（平台已支持 CORS），
 * 因此 APK 无需电脑、无需本地代理。
 */
public class MainActivity extends Activity {

    private static final String TAG = "DeepSeekPocket";
    private static final String HOST = "appassets.local";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_FILE = 1001;
    private static final int REQ_MIC = 1002;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private boolean darkTheme = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window win = getWindow();
        win.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        applySystemBars(false);

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        try {
            s.setUserAgentString(s.getUserAgentString() + " DeepSeekPocket/1.0");
        } catch (Throwable ignored) { }

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "DSAndroid");
        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);

        if (saved != null) {
            web.restoreState(saved);
        } else {
            // 调试用：adb shell am start ... --ez demo true 可进入离线演示（?demo=1）
            Intent it = getIntent();
            boolean demo = it != null && it.getBooleanExtra("demo", false);
            web.loadUrl(demo ? START_URL + "?demo=1" : START_URL);
        }
    }

    /* ------------------------------ 系统栏 ------------------------------ */

    private void applySystemBars(boolean dark) {
        darkTheme = dark;
        Window win = getWindow();
        int bg = Color.parseColor(dark ? "#141519" : "#F7F9FF");
        win.setStatusBarColor(bg);
        win.setNavigationBarColor(Color.parseColor(dark ? "#141519" : "#FFFFFF"));
        View decor = win.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) {
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    /* ------------------------------ 资源拦截 ------------------------------ */

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("css", "text/css");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
        MIME.put("woff", "font/woff");
        MIME.put("ttf", "font/ttf");
        MIME.put("wav", "audio/wav");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("txt", "text/plain");
        MIME.put("md", "text/markdown");
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = path.substring(dot + 1).toLowerCase();
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    private static boolean isText(String mime) {
        return mime.startsWith("text/")
                || mime.contains("json")
                || mime.contains("javascript")
                || mime.contains("svg")
                || mime.contains("xml");
    }

    private WebResourceResponse serveAsset(Uri uri) {
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        if (path.contains("..") || path.contains("\\") || path.contains("%2e")) {
            return error(403, "Forbidden");
        }
        String assetPath = "www" + path;
        try {
            InputStream in = getAssets().open(assetPath);
            String mime = mimeOf(path);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "https://" + HOST);
            return new WebResourceResponse(mime, isText(mime) ? "UTF-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return error(404, "Not Found");
        }
    }

    private WebResourceResponse error(int code, String msg) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", code, msg, headers,
                new ByteArrayInputStream(msg.getBytes(StandardCharsets.UTF_8)));
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri != null && HOST.equals(uri.getHost())) return serveAsset(uri);
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) return false;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            if (HOST.equals(uri.getHost())) return false;
            if (scheme.startsWith("http")) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    toast("没有可打开该链接的应用");
                }
                return true;
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript(
                    "(function(){try{var t=localStorage.getItem('ds.settings');"
                            + "if(!t)return;var s=JSON.parse(t);var d=s.theme==='dark'||(s.theme!=='light'&&s.theme!=='dark'&&false);"
                            + "if(window.DSAndroid)window.DSAndroid.setTheme(!!d);}catch(e){}})()", null);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                List<String> wanted = new ArrayList<>();
                String[] res = request.getResources();
                if (res != null) {
                    for (String r : res) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wanted.add(r);
                    }
                }
                if (wanted.isEmpty()) { request.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(res);
                } else {
                    pendingPermission = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                return true;
            } catch (Exception e) {
                fileCallback = null;
                toast("无法打开文件选择器");
                return false;
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage cm) {
            Log.d(TAG, cm.message() + " @" + cm.sourceId() + ":" + cm.lineNumber());
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQ_MIC) {
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingPermission != null) {
                if (granted) pendingPermission.grant(pendingPermission.getResources());
                else {
                    pendingPermission.deny();
                    toast("未获得麦克风权限，无法语音输入");
                }
                pendingPermission = null;
            }
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] uris = null;
            try {
                if (result == RESULT_OK && data != null) {
                    uris = WebChromeClient.FileChooserParams.parseResult(result, data);
                }
            } catch (Exception ignored) { }
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    /* ------------------------------- JS 桥 ------------------------------- */

    public class Bridge {
        @JavascriptInterface
        public String version() { return "1.0.0"; }

        @JavascriptInterface
        public boolean isAndroid() { return true; }

        @JavascriptInterface
        public String platform() { return "android-" + Build.VERSION.RELEASE; }

        @JavascriptInterface
        public String readClipboard() {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null
                        && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                    return t == null ? "" : t.toString();
                }
            } catch (Exception ignored) { }
            return "";
        }

        @JavascriptInterface
        public boolean copyToClipboard(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("DeepSeek", text == null ? "" : text));
                    return true;
                }
            } catch (Exception ignored) { }
            return false;
        }

        /** 保存文本文件到「下载」目录，返回可展示的位置描述 */
        @JavascriptInterface
        public String saveText(String name, String mime, String text) {
            try {
                String safe = name == null || name.trim().isEmpty() ? "deepseek.txt" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null ? "text/plain" : mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DeepSeek");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) return "";
                        os.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
                    }
                    return "下载/DeepSeek/" + safe;
                }
                File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "DeepSeek");
                if (!dir.exists() && !dir.mkdirs()) return "";
                File f = new File(dir, safe);
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
                }
                return f.getAbsolutePath();
            } catch (Throwable e) {
                Log.w(TAG, "saveText failed", e);
                return "";
            }
        }

        @JavascriptInterface
        public void setTheme(final boolean dark) {
            runOnUiThread(() -> applySystemBars(dark));
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg == null ? "" : msg, Toast.LENGTH_SHORT).show());
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    /* ------------------------------- 生命周期 ------------------------------- */

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript(
                "(function(){try{return !!(window.__dsBack&&window.__dsBack());}catch(e){return false;}})()",
                value -> {
                    boolean handled = "true".equals(value);
                    if (!handled) {
                        if (web.canGoBack()) web.goBack();
                        else moveTaskToBack(true);
                    }
                });
    }
}
