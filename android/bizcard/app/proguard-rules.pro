# ML Kit 텍스트 인식 모델 로더는 리플렉션을 사용한다.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_text_common.** { *; }
-dontwarn com.google.mlkit.**
