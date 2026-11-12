package io.github.moondancer1.tactic;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import android.content.pm.PackageManager;
import android.webkit.WebView;

import java.util.Locale;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS bridge for the foreground service (GPS uplink + keep-alive for WebRTC audio),
 * screen keep-on (Combat mode) and hardware PTT keys.
 */
@CapacitorPlugin(
    name = "Tactical",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class TacticalPlugin extends Plugin {

    private static TacticalPlugin instance;
    static volatile boolean volumeKeyPtt = false;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;

    @Override
    public void load() {
        instance = this;
        // Keep the WebView renderer at foreground priority while the screen is off,
        // otherwise Android may throttle/kill it and voice drops.
        WebView wv = getBridge().getWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        try {
            tts = new TextToSpeech(getContext(), status -> {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                }
            });
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
            }
            tts = null;
        }
        if (instance == this) instance = null;
    }

    static boolean isServiceRunning() {
        return TacticalService.running;
    }

    static void emitPtt(String action, String source, int keyCode) {
        TacticalPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("source", source);
        data.put("keyCode", keyCode);
        p.notifyListeners("pttKey", data, false);
    }

    static void emitLocation(JSObject data) {
        TacticalPlugin p = instance;
        if (p != null) p.notifyListeners("location", data, false);
    }

    static void emitAuthExpired(int status) {
        TacticalPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("status", status);
        p.notifyListeners("authExpired", data, true);
    }

    static void emitStopped() {
        TacticalPlugin p = instance;
        if (p != null) p.notifyListeners("serviceStopped", new JSObject(), false);
    }

    private boolean hasAnyLocationPermission() {
        Context ctx = getContext();
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void start(PluginCall call) {
        boolean needLocation = !hasAnyLocationPermission();
        boolean needMic = getPermissionState("microphone") != PermissionState.GRANTED;
        boolean needNotif = Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED;
        if (needLocation || needMic || needNotif) {
            requestAllPermissions(call, "onPermissions");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void onPermissions(PluginCall call) {
        if (!hasAnyLocationPermission() && call.getBoolean("shareLocation", true)) {
            call.reject("Location permission is required");
            return;
        }
        launch(call);
    }

    private void launch(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(ctx, TacticalService.class)
            .setAction(TacticalService.ACTION_START)
            .putExtra(TacticalService.EXTRA_CONFIG, call.getData().toString());
        try {
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cannot start background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (!TacticalService.running) {
            call.resolve();
            return;
        }
        Context ctx = getContext();
        Intent i = new Intent(ctx, TacticalService.class)
            .setAction(TacticalService.ACTION_UPDATE)
            .putExtra(TacticalService.EXTRA_CONFIG, call.getData().toString());
        ctx.startService(i);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, TacticalService.class));
        call.resolve();
    }

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolumeKeyPtt(PluginCall call) {
        volumeKeyPtt = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void setTransmitting(PluginCall call) {
        TacticalService.setTransmitting(Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject r = new JSObject();
        r.put("value", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(r);
    }

    @SuppressLint("BatteryLife")
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "ru-RU");
        boolean flush = Boolean.TRUE.equals(call.getBoolean("flush", false));
        if (text == null || text.trim().isEmpty() || tts == null || !ttsReady) {
            call.resolve();
            return;
        }
        try {
            Locale loc = (lang != null && lang.toLowerCase(Locale.ROOT).startsWith("en"))
                ? Locale.US
                : new Locale("ru", "RU");
            tts.setLanguage(loc);
            tts.setSpeechRate(1.05f);
            int queueMode = flush ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            tts.speak(text, queueMode, null, "tac_" + System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        call.resolve();
    }
}
