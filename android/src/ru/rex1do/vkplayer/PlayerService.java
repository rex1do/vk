package ru.rex1do.vkplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.view.KeyEvent;

/**
 * Фоновая служба: держит приложение живым, пока играет музыка (навигатор поверх — музыка не стопится),
 * показывает уведомление с кнопками и ведёт медиасессию — через неё работают кнопки на руле
 * магнитолы, медиаклавиши и Bluetooth-гарнитуры.
 */
public class PlayerService extends Service {
    static final String CHANNEL = "playback";
    static final int NOTIFY_ID = 1;
    static String title = "";
    static boolean playing = false;
    static PlayerService running;

    MediaSession session;

    // нажатая медиаклавиша → команда интерфейсу
    static String mediaAction(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return "toggle";
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                return "next";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return "prev";
            default:
                return null;
        }
    }

    static void update(Context ctx, String newTitle, Boolean nowPlaying) {
        if (newTitle != null) title = newTitle;
        if (nowPlaying != null) playing = nowPlaying;
        if (title.isEmpty()) return;
        if (running != null) { running.refresh(); return; }
        if (!playing) return;
        Intent i = new Intent(ctx, PlayerService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, PlayerService.class));
    }

    static void command(String action) {
        MainActivity a = MainActivity.instance;
        if (a != null) a.emit("media", action);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Воспроизведение", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        session = new MediaSession(this, "VK Player");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { command("toggle"); }
            @Override public void onPause() { command("toggle"); }
            @Override public void onSkipToNext() { command("next"); }
            @Override public void onSkipToPrevious() { command("prev"); }
            @Override public void onStop() { if (playing) command("toggle"); }
            @Override public boolean onMediaButtonEvent(Intent intent) {
                KeyEvent e = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                String action = e == null ? null : mediaAction(e.getKeyCode());
                if (action == null) return super.onMediaButtonEvent(intent);
                if (e.getAction() == KeyEvent.ACTION_UP) command(action);
                return true;
            }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if ("toggle".equals(a) || "next".equals(a) || "prev".equals(a)) command(a);
        refresh();
        return START_NOT_STICKY;
    }

    void refresh() {
        String[] parts = title.split(" — ", 2);
        String artist = parts.length > 1 ? parts[0] : "";
        String name = parts.length > 1 ? parts[1] : title;
        session.setMetadata(new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, name)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, name)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, artist)
            .build());
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build());

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_note)
            .setContentTitle(name)
            .setContentText(artist)
            .setContentIntent(open)
            .setOngoing(playing)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Назад", action("prev")).build())
            .addAction(new Notification.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Пауза" : "Играть", action("toggle")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Дальше", action("next")).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        startForeground(NOTIFY_ID, b.build());
        if (!playing && Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH);
    }

    PendingIntent action(String a) {
        Intent i = new Intent(this, PlayerService.class).setAction(a);
        return PendingIntent.getService(this, a.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onDestroy() {
        running = null;
        if (session != null) { session.setActive(false); session.release(); }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
