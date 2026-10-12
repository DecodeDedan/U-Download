import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

// The Android app is versioned on its own (1.x) apart from desktop (3.x), in
// src-tauri/tauri.android.conf.json. Read here rather than from the CLI's
// tauri.properties, which this CLI version never writes; a stuck versionCode
// would make Android refuse every update as a downgrade.
@Suppress("UNCHECKED_CAST")
val androidAppVersion: String = run {
    val conf = file("../../../tauri.android.conf.json")
    val json = groovy.json.JsonSlurper().parse(conf) as Map<String, Any?>
    json["version"] as? String ?: error("tauri.android.conf.json has no \"version\"")
}
val androidVersionCode: Int = run {
    val parts = androidAppVersion.split("-")[0].split(".").map { it.toInt() }
    require(parts.size == 3) { "version must be MAJOR.MINOR.PATCH, got $androidAppVersion" }
    parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing comes from key.properties (git-ignored) or, in CI, from the
// environment; a missing key leaves the release APK unsigned rather than
// silently signing it with the debug key.
val keyProperties = Properties().apply {
    val propFile = rootProject.file("key.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
fun signingValue(key: String, env: String): String? =
    keyProperties.getProperty(key) ?: System.getenv(env)

android {
    compileSdk = 36
    namespace = "com.udownload.application"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.udownload.application"
        minSdk = 24
        targetSdk = 36
        versionCode = androidVersionCode
        versionName = androidAppVersion
    }
    signingConfigs {
        val storeFilePath = signingValue("storeFile", "ANDROID_KEYSTORE_PATH")
        if (storeFilePath != null) {
            create("release") {
                storeFile = file(storeFilePath)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }
    // youtubedl-android runs python, ffmpeg and aria2c as executables out of
    // nativeLibraryDir, which only exists on disk when native libraries are
    // extracted at install time.
    packaging {
        jniLibs.useLegacyPackaging = true
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")