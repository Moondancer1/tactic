# R8 shrinks/optimises the release APK. Capacitor finds plugins and @PluginMethod handlers by
# reflection, and the WebView bridge calls into them by name: keep them intact.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class io.github.moondancer1.tactic.** { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-dontwarn com.getcapacitor.**
