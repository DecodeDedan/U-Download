# youtubedl-android deserialises yt-dlp's JSON into these with Jackson
# reflection; R8 would otherwise strip or rename their fields.
-keep class com.yausername.** { *; }
# Tauri finds the plugin and its commands by reflection.
-keep class com.udownload.engine.** { *; }
# youtubedl-android unpacks Python with Apache Commons Compress, which looks
# its own classes up by name; renamed, the first-launch unpack dies with
# "class ... is not a concrete class" and the engine never starts. The library
# ships this rule in its private proguard-rules.pro, so apps do not inherit it.
-keep class org.apache.commons.compress.** { *; }
-dontwarn org.apache.commons.compress.**
