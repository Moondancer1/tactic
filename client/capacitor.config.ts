import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.moondancer1.tactic',
  appName: 'Tactic',
  webDir: 'dist',
  android: {
    // WebView origin becomes https://localhost (secure context for getUserMedia / Cache API).
    allowMixedContent: false,
    // Never expose the WebView to chrome://inspect (localStorage holds the session token).
    webContentsDebuggingEnabled: false,
    backgroundColor: '#0b0f0c',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
