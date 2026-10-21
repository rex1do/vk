package ru.rex1do.vkplayer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * VK Player для Android. Интерфейс — тот же, что в Windows-версии (папка shell/), он открывается
 * в WebView с адреса https://appassets.androidplatform.net/app/. Вместо основного процесса Electron —
 * этот класс: вход и запросы к API ВК идут через невидимую официальную страницу vk.com с её токеном
 * (клиент самого сайта, как и в Windows-версии), неофициальных клиентов и чужих токенов нет.
 */
public class MainActivity extends Activity {
    static final String ASSET_HOST = "appassets.androidplatform.net";
    static final String SHELL_URL = "https://" + ASSET_HOST + "/app/index.html";
    static final String API_HOST = "https://web.api.vk.ru";
    static final String API_VERSION = "5.289";
    static final String WEB_CLIENT_ID = "6287487";
    static final String DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    static final String RELEASES_API = "https://api.github.com/repos/rex1do/vk/releases/latest";
    static final String RELEASES_URL = "https://github.com/rex1do/vk/releases/latest";

    static MainActivity instance;

    // домен ВК, на котором выполнен вход (vk.com или vk.ru): там живут cookies и оттуда берём токен
    String vkDomain = "vk.com";
    String parking() { return "https://" + vkDomain + "/robots.txt"; }

    final Handler ui = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newCachedThreadPool();
    FrameLayout root;
    WebView shell;
    WebView vk;
    float density = 1f;

    // токены страницы ВК
    String token;            // пользователя или гостевой
    long tokenExpires;       // секунды unix
    String anonToken;
    long anonExpires;
    Boolean loggedIn = null;
    boolean loginMode = false;
    boolean tokenLoading = false;
    final List<Runnable> tokenWaiters = new ArrayList<>();
    final Map<Integer, ApiCall> apiCalls = new java.util.concurrent.ConcurrentHashMap<>();
    int apiSeq = 0;
    String updateUrl = RELEASES_URL;
    boolean immersive = false;

    static class ApiCall {
        int shellId; String method; JSONObject params; boolean anonymous; boolean retry;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        density = getResources().getDisplayMetrics().density;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0c0c10"));
        getWindow().setNavigationBarColor(Color.parseColor("#0c0c10"));

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0c0c10"));
        setContentView(root);

        vkDomain = getSharedPreferences("vk", MODE_PRIVATE).getString("domain", "vk.com");
        shell = new ShellView(this);
        setupShell(shell);
        root.addView(shell, new FrameLayout.LayoutParams(-1, -1));

        vk = new WebView(this);
        setupVk(vk);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
        root.addView(vk, lp);
        vk.setVisibility(View.INVISIBLE);

        shell.loadUrl(SHELL_URL);
        vk.loadUrl(parking());
        checkWebViewVersion();
    }

    // --- Интерфейс ---------------------------------------------------------------------------------

    // интерфейс всегда считает себя на экране: иначе в фоне (поверх навигатор) браузерный движок
    // притормаживает таймеры, и плавные и DJ-переходы съезжают
    static class ShellView extends WebView {
        ShellView(android.content.Context c) { super(c); }
        @Override
        protected void onWindowVisibilityChanged(int visibility) {
            super.onWindowVisibilityChanged(visibility == View.GONE ? visibility : View.VISIBLE);
        }
    }

    void setupShell(WebView w) {
        w.setBackgroundColor(Color.parseColor("#0c0c10"));
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // интерфейс рассчитан на окно от 1280 точек: на экране магнитолы он масштабируется целиком
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.addJavascriptInterface(new Host(), "AndroidHost");
        w.setWebChromeClient(new WebChromeClient());
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!ASSET_HOST.equals(u.getHost())) return null;
                return asset(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (ASSET_HOST.equals(u.getHost())) return false;
                openExternal(u.toString());
                return true;
            }
        });
    }

    // файлы интерфейса из assets; в index.html добавляем мост и стили для Android
    WebResourceResponse asset(String path) {
        if (path == null || path.contains("..")) return null;
        String file = path.startsWith("/") ? path.substring(1) : path;
        try {
            InputStream in = getAssets().open(file);
            String mime = mimeOf(file);
            if (file.equals("app/index.html")) {
                String html = new String(readAll(in), StandardCharsets.UTF_8);
                html = html.replace("<head>", "<head>\n  <meta name=\"viewport\" content=\"width=1280, user-scalable=no\">");
                html = html.replace("</head>", "  <link rel=\"stylesheet\" href=\"android.css\">\n</head>");
                html = html.replaceFirst("<script ", "<script src=\"android-bridge.js\"></script>\n  <script ");
                in = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
            }
            WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("javascript") ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
        }
    }

    static String mimeOf(String f) {
        if (f.endsWith(".html")) return "text/html";
        if (f.endsWith(".js")) return "application/javascript";
        if (f.endsWith(".css")) return "text/css";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    void emit(String channel, Object value) {
        String json = value == null ? "null" : (value instanceof String ? JSONObject.quote((String) value) : value.toString());
        ui.post(() -> shell.evaluateJavascript("window.__vkpEmit && window.__vkpEmit(" + JSONObject.quote(channel) + "," + JSONObject.quote(json) + ")", null));
    }

    void resolve(int id, String json) {
        ui.post(() -> shell.evaluateJavascript("window.__vkpResolve && window.__vkpResolve(" + id + "," + JSONObject.quote(json == null ? "null" : json) + ")", null));
    }

    // --- Невидимая страница ВК: вход и запросы к API -----------------------------------------------

    void setupVk(WebView w) {
        w.setBackgroundColor(Color.parseColor("#141414"));
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(DESKTOP_UA);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        w.addJavascriptInterface(new VkHost(), "VkHost");
        w.setWebChromeClient(new WebChromeClient());
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // страница ВК нужна только для входа: чужие сайты не открываем
                String host = request.getUrl().getHost();
                return host == null || !host.matches("^([\\w-]+\\.)*(vk\\.(com|ru)|vkontakte\\.ru|userapi\\.com|mail\\.ru|ok\\.ru|vk-cdn\\.net)$");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url == null) return;
                boolean vkPage = url.matches("^https://([\\w-]+\\.)*vk\\.(com|ru)/.*");
                if (!vkPage) return;
                if (loginMode) {
                    // после входа ВК уводит на свою страницу — проверяем, появился ли вход
                    Matcher m = Pattern.compile("^https://(?:www\\.|m\\.)?(vk\\.(?:com|ru))/").matcher(url);
                    if (m.find() && !url.contains("/login")) {
                        vkDomain = m.group(1);
                        loadTokens();
                    }
                } else if (url.startsWith(parking())) {
                    loadTokens();
                } else {
                    view.loadUrl(parking());
                }
            }
        });
    }

    // токен сайта ВК: для вошедшего — тот, что сайт получает сам (act=web_token), для гостя — гостевой
    int tokenRun = 0;
    void loadTokens() {
        if (tokenLoading) return;
        tokenLoading = true;
        int run = ++tokenRun;
        // страница могла уйти на другой адрес посреди запроса — не ждём вечно
        ui.postDelayed(() -> { if (tokenLoading && run == tokenRun) { tokenLoading = false; if (!tokenWaiters.isEmpty()) loadTokens(); } }, 15000);
        String js = "(async () => {"
            + " let user = null, anon = null;"
            + " try { const r = await fetch('https://login." + vkDomain + "/?act=web_token', { method: 'POST', credentials: 'include',"
            + "   body: new URLSearchParams({ version: '1', app_id: '" + WEB_CLIENT_ID + "' }) });"
            + "   const j = await r.json(); if (j && j.type === 'okay' && j.data && j.data.access_token) user = j.data; } catch (e) {}"
            + " if (!user) anon = await window.__vkpAnon();"
            + " VkHost.tokens(JSON.stringify({ user, anon }));"
            + "})()";
        ui.post(() -> vk.evaluateJavascript(ANON_JS + js, null));
    }

    static final String ANON_JS = "window.__vkpAnon = async () => { try {"
        + " const body = new URLSearchParams({ client_secret: 'QbYic1K3lEV5kTGiqlq2', client_id: '" + WEB_CLIENT_ID + "',"
        + "   scopes: 'audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous', isApiOauthAnonymEnabled: 'false', version: '1', app_id: '" + WEB_CLIENT_ID + "' });"
        + " const r = await fetch('https://login.vk.ru/?act=get_anonym_token', { method: 'POST', body, credentials: 'omit' });"
        + " const j = await r.json(); return j && j.data && j.data.access_token ? j.data : null; } catch (e) { return null; } };";

    void onTokens(String json) {
        tokenLoading = false;
        try {
            JSONObject o = new JSONObject(json);
            JSONObject user = o.optJSONObject("user");
            JSONObject anon = o.optJSONObject("anon");
            boolean isUser = user != null;
            if (isUser) {
                token = user.getString("access_token");
                tokenExpires = expiresOf(user);
            } else if (anon != null) {
                token = anon.getString("access_token");
                tokenExpires = expiresOf(anon);
                anonToken = token;
                anonExpires = tokenExpires;
            }
            if (token != null) {
                List<Runnable> waiters = new ArrayList<>(tokenWaiters);
                tokenWaiters.clear();
                for (Runnable r : waiters) r.run();
            }
            if (loggedIn == null || loggedIn != isUser) {
                loggedIn = isUser;
                emit("auth-changed", new JSONObject().put("loggedIn", isUser));
            }
            if (isUser) getSharedPreferences("vk", MODE_PRIVATE).edit().putString("domain", vkDomain).apply();
            if (isUser && loginMode) finishLogin();
        } catch (Exception e) {
            ui.postDelayed(this::loadTokens, 5000);
        }
    }

    static long expiresOf(JSONObject o) {
        long e = o.optLong("expires", 0);
        if (e == 0) e = o.optLong("expired_at", 0);
        return e;
    }

    boolean tokenFresh() {
        return token != null && (tokenExpires == 0 || tokenExpires * 1000 > System.currentTimeMillis() + 60000);
    }

    void withToken(Runnable r) {
        ui.post(() -> {
            if (tokenFresh()) { r.run(); return; }
            tokenWaiters.add(r);
            String at = vk.getUrl();
            if (!loginMode && (at == null || !at.startsWith(parking()))) vk.loadUrl(parking()); else loadTokens();
        });
    }

    void api(ApiCall c) {
        if (loginMode) { failApi(c, "Идёт вход во ВКонтакте", 0); return; }
        withToken(() -> {
            if (c.anonymous && (anonToken == null || anonExpires * 1000 < System.currentTimeMillis() + 60000)) {
                int id = ++apiSeq;
                apiCalls.put(id, c);
                vk.evaluateJavascript(ANON_JS + "window.__vkpAnon().then((a) => VkHost.anon(" + id + ", JSON.stringify(a)))", null);
                return;
            }
            runApi(c);
        });
    }

    void runApi(ApiCall c) {
        try {
            JSONObject body = new JSONObject();
            body.put("lang", "ru");
            JSONArray names = c.params.names();
            if (names != null) for (int i = 0; i < names.length(); i++) {
                String k = names.getString(i);
                body.put(k, String.valueOf(c.params.get(k)));
            }
            body.put("access_token", c.anonymous ? anonToken : token);
            int id = ++apiSeq;
            apiCalls.put(id, c);
            String url = API_HOST + "/method/" + c.method + "?v=" + API_VERSION + "&client_id=" + WEB_CLIENT_ID;
            String js = "fetch(" + JSONObject.quote(url) + ", { method: 'POST', credentials: '" + (c.anonymous ? "omit" : "include") + "',"
                + " body: new URLSearchParams(" + body + ") }).then((r) => r.text())"
                + ".then((t) => VkHost.done(" + id + ", t), (e) => VkHost.fail(" + id + ", String(e)))";
            vk.evaluateJavascript(js, null);
            // страница ВК перезагрузилась посреди запроса — отвечаем ошибкой, а не зависаем
            ui.postDelayed(() -> { if (apiCalls.remove(id) != null) failApi(c, "Нет связи с ВКонтакте", 0); }, 30000);
        } catch (Exception e) {
            failApi(c, e.getMessage(), 0);
        }
    }

    void onApiDone(int id, String text) {
        ApiCall c = apiCalls.remove(id);
        if (c == null) return;
        io.execute(() -> {
            try {
                JSONObject o = new JSONObject(text);
                if (o.has("error")) {
                    JSONObject err = o.getJSONObject("error");
                    int code = err.optInt("error_code", 0);
                    if (c.retry && (code == 5 || code == 1114 || code == 1116)) {
                        // токен протух — получаем свежий и повторяем
                        c.retry = false;
                        ui.post(() -> {
                            if (c.anonymous) anonToken = null; else tokenExpires = 1;
                            api(c);
                        });
                        return;
                    }
                    failApi(c, err.optString("error_msg", "Ошибка ВКонтакте"), code);
                    return;
                }
                Object data = o.opt("response");
                String raw = data == null ? "null"
                    : data instanceof String ? JSONObject.quote((String) data)
                    : String.valueOf(data);
                resolve(c.shellId, "{\"ok\":true,\"data\":" + raw + "}");
            } catch (Exception e) {
                failApi(c, "Нет связи с ВКонтакте", 0);
            }
        });
    }

    void failApi(ApiCall c, String msg, int code) {
        try {
            resolve(c.shellId, new JSONObject().put("ok", false).put("error", msg).put("code", code).toString());
        } catch (Exception ignored) { }
    }

    // --- Вход ------------------------------------------------------------------------------------------

    void showLogin(JSONObject rect) {
        loginMode = true;
        placeVk(rect);
        vk.setVisibility(View.VISIBLE);
        vk.requestFocus();
        vk.loadUrl("https://vk.com/login");
    }

    void placeVk(JSONObject rect) {
        if (rect == null) return;
        float scale = shell.getWidth() / (float) Math.max(1, rect.optDouble("viewport", 1280));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            Math.max(1, Math.round((float) rect.optDouble("width") * scale)),
            Math.max(1, Math.round((float) rect.optDouble("height") * scale)));
        lp.leftMargin = Math.round((float) rect.optDouble("x") * scale);
        lp.topMargin = Math.round((float) rect.optDouble("y") * scale);
        vk.setLayoutParams(lp);
    }

    void finishLogin() {
        loginMode = false;
        hideVk();
        vk.loadUrl(parking());
        emit("login-closed", null);
    }

    void cancelLogin() {
        loginMode = false;
        hideVk();
        vk.loadUrl(parking());
    }

    void hideVk() {
        vk.setVisibility(View.INVISIBLE);
        vk.setLayoutParams(new FrameLayout.LayoutParams(1, 1));
        shell.requestFocus();
    }

    void logout() {
        CookieManager.getInstance().removeAllCookies(ok -> {
            token = null;
            loggedIn = null;
            vk.clearCache(false);
            vk.loadUrl(parking());
        });
    }

    // --- Команды из интерфейса ------------------------------------------------------------------------

    class Host {
        @JavascriptInterface
        public void call(int id, String name, String argsJson) {
            try {
                JSONArray a = new JSONArray(argsJson);
                switch (name) {
                    case "api": {
                        ApiCall c = new ApiCall();
                        c.shellId = id;
                        c.method = a.getString(0);
                        if (!c.method.matches("^[a-zA-Z]+\\.[a-zA-Z]+$")) { failApi(c, "bad method", 0); return; }
                        c.params = a.optJSONObject(1) != null ? a.optJSONObject(1) : new JSONObject();
                        JSONObject opt = a.optJSONObject(2);
                        c.anonymous = opt != null && opt.optBoolean("anonymous");
                        c.retry = true;
                        api(c);
                        break;
                    }
                    case "authState":
                        ui.post(() -> {
                            Runnable done = () -> { try { resolve(id, new JSONObject().put("loggedIn", Boolean.TRUE.equals(loggedIn)).toString()); } catch (Exception ignored) { } };
                            if (token != null) done.run();
                            else {
                                tokenWaiters.add(done);
                                ui.postDelayed(() -> { if (tokenWaiters.remove(done)) done.run(); }, 20000);
                            }
                        });
                        break;
                    case "httpText": {
                        String url = a.getString(0), accept = a.optString(1, "text/html");
                        io.execute(() -> {
                            String text = httpText(url, accept);
                            try { resolve(id, text == null ? "null" : new JSONObject().put("text", text).toString()); } catch (Exception e) { resolve(id, "null"); }
                        });
                        break;
                    }
                    default:
                        resolve(id, "null");
                }
            } catch (Exception e) {
                resolve(id, "null");
            }
        }

        @JavascriptInterface
        public void send(String name, String argsJson) {
            ui.post(() -> {
                try {
                    JSONArray a = new JSONArray(argsJson);
                    switch (name) {
                        case "login": showLogin(a.optJSONObject(0)); break;
                        case "loginBounds": if (loginMode) placeVk(a.optJSONObject(0)); break;
                        case "loginCancel": cancelLogin(); break;
                        case "logout": logout(); break;
                        case "window": windowAction(a.optString(0)); break;
                        case "trackTitle": PlayerService.update(MainActivity.this, a.optString(0), null); break;
                        case "playState": PlayerService.update(MainActivity.this, null, a.optBoolean(0)); break;
                        case "openUrl": openExternal(a.optString(0)); break;
                        case "openUpdate": openExternal(updateUrl); break;
                        case "ready": onShellReady(); break;
                        default: break;
                    }
                } catch (Exception ignored) { }
            });
        }

        // сохранение файла кусками: начало → куски base64 → конец (возвращает, куда сохранено)
        @JavascriptInterface
        public String saveBegin(String name, String mime, String folder) {
            return Saver.begin(MainActivity.this, name, mime, folder);
        }

        @JavascriptInterface
        public boolean saveChunk(String handle, String base64) {
            return Saver.chunk(handle, Base64.decode(base64, Base64.DEFAULT));
        }

        @JavascriptInterface
        public String saveEnd(String handle) {
            return Saver.end(handle);
        }
    }

    class VkHost {
        @JavascriptInterface public void tokens(String json) { ui.post(() -> onTokens(json)); }
        @JavascriptInterface public void done(int id, String text) { onApiDone(id, text); }
        @JavascriptInterface public void fail(int id, String msg) {
            ApiCall c = apiCalls.remove(id);
            if (c != null) failApi(c, "Нет связи с ВКонтакте", 0);
        }
        @JavascriptInterface public void anon(int id, String json) {
            ui.post(() -> {
                ApiCall c = apiCalls.remove(id);
                if (c == null) return;
                try {
                    JSONObject a = new JSONObject(json);
                    anonToken = a.getString("access_token");
                    anonExpires = expiresOf(a);
                    runApi(c);
                } catch (Exception e) {
                    failApi(c, "Нет связи с ВКонтакте", 0);
                }
            });
        }
    }

    void onShellReady() {
        try { emit("window-state", new JSONObject().put("maximized", true).put("fullscreen", immersive)); } catch (Exception ignored) { }
        if (loggedIn != null) try { emit("auth-changed", new JSONObject().put("loggedIn", loggedIn)); } catch (Exception ignored) { }
        checkForUpdates();
    }

    void windowAction(String action) {
        switch (action) {
            case "fullscreen": setFullscreen(true); break;
            case "exit-fullscreen": setFullscreen(false); break;
            case "minimize":
            case "close": moveTaskToBack(true); break;
            default: break;
        }
    }

    void setFullscreen(boolean on) {
        immersive = on;
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(on
            ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            : 0);
        try { emit("window-state", new JSONObject().put("maximized", true).put("fullscreen", on)); } catch (Exception ignored) { }
    }

    // --- Сеть ------------------------------------------------------------------------------------------

    static String httpText(String url, String accept) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setRequestProperty("User-Agent", DESKTOP_UA);
            c.setRequestProperty("Accept", accept);
            c.setRequestProperty("Accept-Language", "ru,en;q=0.8");
            if (c.getResponseCode() / 100 != 2) return null;
            return new String(readAll(c.getInputStream()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) { }
    }

    // --- Обновления: новая версия на GitHub — плашка с кнопкой «Скачать» (сразу APK) -------------------

    boolean updateChecked = false;
    void checkForUpdates() {
        if (updateChecked) return;
        updateChecked = true;
        io.execute(() -> {
            try {
                String text = httpText(RELEASES_API, "application/vnd.github+json");
                if (text == null) return;
                JSONObject rel = new JSONObject(text);
                String latest = rel.optString("tag_name", "").replaceFirst("^v", "");
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                if (!newer(latest, pi.versionName)) return;
                JSONArray assets = rel.optJSONArray("assets");
                if (assets != null) for (int i = 0; i < assets.length(); i++) {
                    JSONObject as = assets.getJSONObject(i);
                    if (as.optString("name").endsWith(".apk")) { updateUrl = as.optString("browser_download_url", RELEASES_URL); break; }
                }
                emit("update-state", new JSONObject().put("state", "available-portable").put("version", latest));
            } catch (Exception ignored) { }
        });
    }

    static boolean newer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parseInt(x[i]) : 0, q = i < y.length ? parseInt(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    static int parseInt(String s) {
        try { return Integer.parseInt(s.replaceAll("\\D.*$", "")); } catch (Exception e) { return 0; }
    }

    // интерфейсу нужен свежий WebView (Chrome 100+): на старом он не запустится
    void checkWebViewVersion() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            PackageInfo p = WebView.getCurrentWebViewPackage();
            if (p == null) return;
            Matcher m = Pattern.compile("^(\\d+)").matcher(p.versionName);
            if (m.find() && Integer.parseInt(m.group(1)) < 100) {
                new AlertDialog.Builder(this)
                    .setTitle("Обновите Android System WebView")
                    .setMessage("Для VK Player нужен WebView версии 100 или новее, сейчас установлена " + p.versionName
                        + ". Обновите «Android System WebView» (или Google Chrome) в Play Маркете.")
                    .setPositiveButton("Открыть Play Маркет", (d, w) -> openExternal("market://details?id=" + p.packageName))
                    .setNegativeButton("Позже", null)
                    .show();
            }
        } catch (Exception ignored) { }
    }

    // --- Кнопки ---------------------------------------------------------------------------------------

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        String action = PlayerService.mediaAction(e.getKeyCode());
        if (action != null) {
            if (e.getAction() == KeyEvent.ACTION_UP) emit("media", action);
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    // «Назад»: закрываем открытое (плеер на весь экран, окна), иначе — сворачиваемся, музыка играет
    @Override
    public void onBackPressed() {
        if (loginMode) { shell.evaluateJavascript("document.getElementById('login-close') && document.getElementById('login-close').click()", null); cancelLogin(); return; }
        shell.evaluateJavascript("(() => { const b = document.body, open = b.classList.contains('fs-open') || b.classList.contains('immersive')"
            + " || !document.getElementById('eq-panel').hidden || !document.getElementById('login-modal').hidden"
            + " || Boolean(document.getElementById('uc-details') || document.getElementById('mix-settings'));"
            + " if (open) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));"
            + " return open; })()", value -> {
            if ("false".equals(value)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        emit("window-visible", true);
        if (immersive) setFullscreen(true);
    }

    @Override
    protected void onPause() {
        super.onPause();
        emit("window-visible", false);
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (instance == this) instance = null;
        PlayerService.stop(this);
        super.onDestroy();
    }

    // --- Сохранение файлов: «Музыка/VK Player» и «Загрузки» -------------------------------------------

    static class Saver {
        static final Map<String, OutputStream> open = new HashMap<>();
        static final Map<String, String> where = new HashMap<>();
        static int seq = 0;

        static synchronized String begin(Activity a, String name, String mime, String folder) {
            try {
                boolean music = "music".equals(folder);
                OutputStream out;
                String shown;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver cr = a.getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    String rel = music ? Environment.DIRECTORY_MUSIC + "/VK Player" : Environment.DIRECTORY_DOWNLOADS;
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
                    Uri base = music ? MediaStore.Audio.Media.EXTERNAL_CONTENT_URI : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                    Uri uri = cr.insert(base, v);
                    if (uri == null) return null;
                    out = cr.openOutputStream(uri);
                    shown = rel + "/" + name;
                } else {
                    File dir = music
                        ? new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "VK Player")
                        : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists() && !dir.mkdirs()) dir = a.getExternalFilesDir(music ? Environment.DIRECTORY_MUSIC : Environment.DIRECTORY_DOWNLOADS);
                    File f = new File(dir, name);
                    out = new FileOutputStream(f);
                    shown = f.getAbsolutePath();
                }
                String h = String.valueOf(++seq);
                open.put(h, out);
                where.put(h, shown);
                return h;
            } catch (Exception e) {
                return null;
            }
        }

        static synchronized boolean chunk(String h, byte[] data) {
            OutputStream out = open.get(h);
            if (out == null) return false;
            try { out.write(data); return true; } catch (Exception e) { return false; }
        }

        static synchronized String end(String h) {
            OutputStream out = open.remove(h);
            try { if (out != null) out.close(); } catch (Exception ignored) { }
            return where.remove(h);
        }
    }
}
