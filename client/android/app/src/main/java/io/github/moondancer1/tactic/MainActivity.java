package io.github.moondancer1.tactic;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TacticalPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Hardware PTT while the activity has focus: volume-down (opt-in) and headset/media keys.
     * With the screen off, media keys are delivered to TacticalService's MediaSession instead.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        String source = null;
        if (TacticalPlugin.volumeKeyPtt && code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            source = "volume";
        } else if (TacticalPlugin.isServiceRunning() && TacticalService.isPttKey(code)) {
            source = "headset";
        }
        if (source == null) return super.dispatchKeyEvent(event);

        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            TacticalPlugin.emitPtt("down", source, code);
        } else if (event.getAction() == KeyEvent.ACTION_UP) {
            TacticalPlugin.emitPtt("up", source, code);
        }
        return true;
    }
}
