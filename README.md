# FreeDesk

FreeDesk, kendi sunucunuz üzerinden çalışan bir uzak masaüstü programıdır
(Windows ve macOS). Karşı tarafın ID'sini yazıp bağlantı isteği gönderirsiniz;
karşı taraf kabul edince ekranına erişirsiniz.

## İndirme

Son sürüm: [Releases](https://github.com/tuncer4427/freedesk/releases/latest)

- Windows: `freedesk-<sürüm>-x86_64.exe`
- macOS (Apple Silicon): `freedesk-<sürüm>-aarch64.dmg`
- macOS (Intel): `freedesk-<sürüm>-x86_64.dmg`

## Yeni sürüm yayınlama

1. Sürüm numarasını dört yerde yükseltin: `Cargo.toml`, `libs/portable/Cargo.toml`,
   `flutter/pubspec.yaml` ve `.github/workflows/freedesk-release.yml` (`VERSION`).
2. Değişikliği `main` dalına gönderin ve sürümle aynı adda bir etiket (tag) oluşturun,
   örneğin `1.5.4`.
3. GitHub Actions kurulum dosyalarını derler ve sürümü yayınlar; kurulu programlar
   yeni sürümü buradan bulur.

Otomatik güncellemenin çalışması için depoda `FREEDESK_UPDATE_ED25519_SEED` adlı
gizli anahtar (secret) tanımlı olmalıdır.

## Kaynak ve lisans

FreeDesk, [RustDesk](https://github.com/rustdesk/rustdesk) 1.5.3 kaynak kodu üzerine
kuruludur ve aynı lisansla (AGPL-3.0, bkz. `LICENCE`) dağıtılır. FreeDesk'e özgü
değişiklikler `freedesk/apply_branding.py` dosyasında toplanmıştır. Sunucu tarafı
[rustdesk-server](https://github.com/rustdesk/rustdesk-server) kullanır.
