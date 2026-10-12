# youtubedl-android deserialises yt-dlp's JSON into these with Jackson
# reflection; R8 would otherwise strip or rename their fields.
-keep class com.yausername.** { *; }
# Tauri finds the plugin and its commands by reflection.
-keep class com.udownload.engine.** { *; }
