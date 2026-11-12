import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.moondancer1.tactic',
  appName: 'Tactic',
  webDir: 'dist',
  android: {
    // WebView origin becomes https://localhost (secure context for getUserMedia / Cache API).
    allowMixedContent: false,
    backgroundColor: '#0b0f0c',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
