plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.udownload.engine"
    // 35+ for Service.onTimeout, which Android 15 calls when the dataSync
    // foreground-service budget runs out.
    compileSdk = 36

    defaultConfig {
        // youtubedl-android's own floor.
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

val youtubedlAndroid = "0.18.1"

dependencies {
    // The Seal engine: Python + yt-dlp, ffmpeg and aria2c as native libraries.
    api("io.github.junkfood02.youtubedl-android:library:$youtubedlAndroid")
    api("io.github.junkfood02.youtubedl-android:ffmpeg:$youtubedlAndroid")
    api("io.github.junkfood02.youtubedl-android:aria2c:$youtubedlAndroid")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    implementation(project(":tauri-android"))
}
