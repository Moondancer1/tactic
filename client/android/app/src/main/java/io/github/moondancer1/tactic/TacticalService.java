package io.github.moondancer1.tactic;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground service (types: location | microphone) that keeps the game running with the screen off:
 *  - owns GPS via FusedLocationProvider and POSTs fixes to /api/telemetry itself, so tracking
 *    works even if the WebView is throttled;
 *  - throttles GPS: active (combat) / eco interval while moving with screen on, idle interval
 *    when the screen is off or the device has been stationary for 30 s;
 *  - holds a partial wake lock + low-latency Wi-Fi lock so WebRTC audio in the WebView keeps flowing;
 *  - owns a MediaSession so headset hook / Play-Pause buttons trigger PTT on a locked screen.
 */
public class TacticalService extends Service {

    static final String ACTION_START = "io.github.moondancer1.tactic.START";
    static final String ACTION_UPDATE = "io.github.moondancer1.tactic.UPDATE";
    static final String ACTION_STOP = "io.github.moondancer1.tactic.STOP";
    static final String EXTRA_CONFIG = "config";

    private static final String TAG = "TacticalService";
    private static final String CHANNEL_ID = "tactic_service";
    private static final int NOTIFICATION_ID = 4711;
    private static final String PREFS = "tactic_service";
    private static final long STATIONARY_AFTER_MS = 30_000;
    private static final float MOVE_THRESHOLD_M = 8f;
    private static final int MAX_PENDING = 30;

    static volatile boolean running = false;
    private static volatile TacticalService current;

    // config
    private String server = "";
    private String token = "";
    private String mode = "eco";
    private long activeMs = 2000, ecoMs = 5000, idleMs = 15000;
    private boolean share = true;
    private String title = "Tactic";

    // state
    private FusedLocationProviderClient fused;
    private long requestedInterval = -1;
    private boolean screenOn = true;
    private Location anchor;
    private long lastMoveAt = SystemClock.elapsedRealtime();
    private long lastSentAt = 0;
    private Location lastSent;
    private String tier = "active";
    private boolean transmitting = false;
    private final ArrayDeque<JSONObject> pending = new ArrayDeque<>();
    private final ExecutorService net = Executors.newSingleThreadExecutor();

    private PowerManager.WakeLock cpuLock;
    private WifiManager.WifiLock wifiLock;
    private MediaSession mediaSession;

    private final LocationCallback locationCallback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            for (Location l : result.getLocations()) onLocation(l);
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            screenOn = Intent.ACTION_SCREEN_ON.equals(i.getAction());
            reschedule();
        }
    };

    // ---------- lifecycle ----------

    @Override
    public void onCreate() {
        super.onCreate();
        current = this;
        fused = LocationServices.getFusedLocationProviderClient(this);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        screenOn = pm == null || pm.isInteractive();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Restarted by the system after being killed: restore last config.
        String json = intent != null ? intent.getStringExtra(EXTRA_CONFIG) : null;
        if (json == null) json = getSharedPreferences(PREFS, MODE_PRIVATE).getString(EXTRA_CONFIG, null);
        if (json != null) applyConfig(json, ACTION_START.equals(action) || intent == null);

        if (!running) {
            if (!startInForeground()) {
                stopSelf();
                return START_NOT_STICKY;
            }
            running = true;
            acquireLocks();
            setupMediaSession();
            IntentFilter f = new IntentFilter();
            f.addAction(Intent.ACTION_SCREEN_ON);
            f.addAction(Intent.ACTION_SCREEN_OFF);
            ContextCompat.registerReceiver(this, screenReceiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        } else {
            updateNotification();
        }
        requestedInterval = -1;
        reschedule();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        current = null;
        fused.removeLocationUpdates(locationCallback);
        try {
            unregisterReceiver(screenReceiver);
        } catch (IllegalArgumentException ignored) {
        }
        if (mediaSession != null) mediaSession.release();
        if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        net.shutdown();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(EXTRA_CONFIG).apply();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        TacticalPlugin.emitStopped();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- config ----------

    private void applyConfig(String json, boolean persist) {
        try {
            JSONObject o = new JSONObject(json);
            server = o.optString("server", server).replaceAll("/+$", "");
            token = o.optString("token", token);
            mode = o.optString("mode", mode);
            activeMs = clamp(o.optLong("activeIntervalMs", activeMs), 1000, 60000);
            ecoMs = clamp(o.optLong("ecoIntervalMs", ecoMs), 1000, 120000);
            idleMs = clamp(o.optLong("idleIntervalMs", idleMs), 2000, 300000);
            share = o.optBoolean("shareLocation", share);
            title = o.optString("title", title);
        } catch (JSONException e) {
            Log.w(TAG, "bad config", e);
        }
        // Persist merged config so a sticky restart can resume.
        try {
            JSONObject merged = new JSONObject()
                .put("server", server).put("token", token).put("mode", mode)
                .put("activeIntervalMs", activeMs).put("ecoIntervalMs", ecoMs).put("idleIntervalMs", idleMs)
                .put("shareLocation", share).put("title", title);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(EXTRA_CONFIG, merged.toString()).apply();
        } catch (JSONException ignored) {
        }
    }

    private static long clamp(long v, long lo, long hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    // ---------- foreground notification ----------

    private boolean startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Radio & GPS", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps voice and position sharing alive while the screen is off");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int types = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && granted(Manifest.permission.RECORD_AUDIO)) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            if (types == 0) {
                Log.w(TAG, "no location/microphone permission; cannot start typed foreground service");
                return false;
            }
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), types);
            return true;
        } catch (Exception e) {
            // e.g. ForegroundServiceStartNotAllowedException when started from background
            Log.e(TAG, "startForeground failed", e);
            return false;
        }
    }

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED;
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, TacticalService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = transmitting
            ? "● TRANSMITTING"
            : (share ? "GPS " + tier.toUpperCase() + " · " : "GPS off · ") + "radio listening";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openPi)
            .addAction(0, "Stop", stopPi)
            .build();
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null && running) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    static void setTransmitting(boolean on) {
        TacticalService s = current;
        if (s == null) return;
        s.transmitting = on;
        s.updateNotification();
    }

    // ---------- locks & media session ----------

    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tactic:radio");
            cpuLock.setReferenceCounted(false);
            cpuLock.acquire(12 * 60 * 60 * 1000L); // safety cap: a long game day
        }
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wm != null) {
            int wifiMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(wifiMode, "tactic:radio");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
    }

    static boolean isPttKey(int code) {
        return code == KeyEvent.KEYCODE_HEADSETHOOK
            || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            || code == KeyEvent.KEYCODE_MEDIA_PLAY
            || code == KeyEvent.KEYCODE_MEDIA_PAUSE;
    }

    private void setupMediaSession() {
        mediaSession = new MediaSession(this, "TacticPTT");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public boolean onMediaButtonEvent(@NonNull Intent i) {
                KeyEvent ke = Build.VERSION.SDK_INT >= 33
                    ? i.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent.class)
                    : legacyKeyEvent(i);
                if (ke == null || !isPttKey(ke.getKeyCode())) return super.onMediaButtonEvent(i);
                // Wired headset hooks deliver DOWN/UP (true hold-to-talk). Many BT headsets send
                // a single PLAY_PAUSE tap; the JS side treats those as toggle.
                if (ke.getAction() == KeyEvent.ACTION_DOWN && ke.getRepeatCount() == 0) {
                    TacticalPlugin.emitPtt("down", "headset", ke.getKeyCode());
                } else if (ke.getAction() == KeyEvent.ACTION_UP) {
                    TacticalPlugin.emitPtt("up", "headset", ke.getKeyCode());
                }
                return true;
            }
        });
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE)
            .setState(PlaybackState.STATE_PLAYING, 0, 1f)
            .build());
        mediaSession.setActive(true);
    }

    @SuppressWarnings("deprecation")
    private static KeyEvent legacyKeyEvent(Intent i) {
        return i.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
    }

    // ---------- GPS ----------

    private boolean isStationary() {
        return SystemClock.elapsedRealtime() - lastMoveAt > STATIONARY_AFTER_MS;
    }

    private void reschedule() {
        if (!share) {
            fused.removeLocationUpdates(locationCallback);
            requestedInterval = -1;
            tier = "off";
            updateNotification();
            return;
        }
        String newTier;
        long interval;
        if (!screenOn || isStationary()) {
            newTier = "idle";
            interval = idleMs;
        } else if ("combat".equals(mode)) {
            newTier = "active";
            interval = activeMs;
        } else {
            newTier = "eco";
            interval = ecoMs;
        }
        boolean tierChanged = !newTier.equals(tier);
        tier = newTier;
        if (tierChanged) updateNotification();
        if (interval == requestedInterval) return;
        requestedInterval = interval;

        // Idle keeps high accuracy (positions matter in a game) but lets the GPS sleep between fixes.
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
            .setMinUpdateIntervalMillis(Math.max(1000, interval / 2))
            .setWaitForAccurateLocation(false)
            .build();
        try {
            fused.removeLocationUpdates(locationCallback);
            fused.requestLocationUpdates(req, locationCallback, Looper.getMainLooper());
        } catch (SecurityException e) {
            Log.w(TAG, "location permission missing", e);
        }
    }

    private void onLocation(Location l) {
        long now = SystemClock.elapsedRealtime();
        float acc = l.hasAccuracy() ? l.getAccuracy() : 50f;
        float threshold = Math.max(MOVE_THRESHOLD_M, Math.min(acc, 30f));
        if (anchor == null || l.distanceTo(anchor) > threshold) {
            anchor = l;
            lastMoveAt = now;
        }

        boolean jumped = lastSent == null || l.distanceTo(lastSent) > 25f;
        boolean due = now - lastSentAt >= requestedInterval - 250;

        Double heading = (l.hasBearing() && l.hasSpeed() && l.getSpeed() > 1.2f) ? (double) l.getBearing() : null;
        Integer bat = batteryPercent();

        JSObject ev = new JSObject();
        ev.put("lat", l.getLatitude());
        ev.put("lon", l.getLongitude());
        ev.put("acc", acc);
        ev.put("heading", heading);
        ev.put("speed", l.hasSpeed() ? l.getSpeed() : null);
        ev.put("bat", bat);
        ev.put("ts", l.getTime());
        ev.put("tier", tier);
        TacticalPlugin.emitLocation(ev);

        if (due || jumped) {
            lastSentAt = now;
            lastSent = l;
            try {
                JSONObject pos = new JSONObject()
                    .put("lat", l.getLatitude())
                    .put("lon", l.getLongitude())
                    .put("acc", Math.min(acc, 99999))
                    .put("heading", heading == null ? JSONObject.NULL : heading)
                    .put("speed", l.hasSpeed() ? l.getSpeed() : JSONObject.NULL)
                    .put("bat", bat == null ? JSONObject.NULL : bat)
                    .put("ts", l.getTime());
                send(pos);
            } catch (JSONException ignored) {
            }
        }
        reschedule();
    }

    @Nullable
    private Integer batteryPercent() {
        BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
        if (bm == null) return null;
        int v = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        return v > 0 ? v : null;
    }

    /** Queue + batch upload; keeps the last MAX_PENDING fixes while the network is down. */
    private void send(JSONObject pos) {
        if (server.isEmpty() || token.isEmpty()) return;
        synchronized (pending) {
            pending.addLast(pos);
            while (pending.size() > MAX_PENDING) pending.removeFirst();
        }
        final String url = server + "/api/telemetry";
        final String auth = "Bearer " + token;
        net.execute(() -> {
            JSONArray batch = new JSONArray();
            synchronized (pending) {
                if (pending.isEmpty()) return;
                for (JSONObject p : pending) batch.put(p);
            }
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("Authorization", auth);
                byte[] body = batch.toString().getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body);
                }
                int code = c.getResponseCode();
                if (code < 500) {
                    // 2xx: delivered. 4xx: will never succeed (expired token / bad data) - drop.
                    synchronized (pending) {
                        for (int k = 0; k < batch.length() && !pending.isEmpty(); k++) pending.removeFirst();
                    }
                }
                if (code == 401) Log.w(TAG, "telemetry unauthorized; re-join required");
            } catch (Exception e) {
                Log.d(TAG, "telemetry failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }
}
