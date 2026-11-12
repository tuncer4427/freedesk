#!/usr/bin/env python3
"""Apply the FreeDesk branding/server/updater changes on top of a RustDesk tree.

Kept in the repository so the same changes can be re-applied after pulling a
newer upstream RustDesk release. Every replacement must match, otherwise the
script fails loudly instead of silently producing a half-branded build.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

APP = "FreeDesk"
APP_LOWER = "freedesk"
GITHUB_OWNER = "tuncer4427"
GITHUB_REPO = "freedesk"
SERVER = "185.233.247.38"
SERVER_KEY = "M9VY1U7bnEbSznDpjBok8BmzDNvaomgjmUlG4WY9Bss="
BUNDLE_ID = "com.freedesk.app"
# Public half of the update-signing key (the private seed is the
# FREEDESK_UPDATE_ED25519_SEED repository secret).
UPDATE_PUBLIC_KEY = [
    182, 221, 224, 147, 135, 22, 203, 230, 138, 164, 73, 236, 29, 219, 36, 255,
    94, 22, 236, 24, 54, 67, 250, 53, 37, 182, 74, 4, 171, 197, 64, 34,
]
VERSION_URL = (
    f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}"
    f"/releases/latest/download/{APP_LOWER}-version.json"
)


def sub(path, old, new, count=1):
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    found = text.count(old)
    if found != count:
        sys.exit(f"{path}: expected {count} match(es) of {old!r}, found {found}")
    file.write_text(text.replace(old, new), encoding="utf-8")


# --- app name, built-in server and key -------------------------------------
cfg = "libs/hbb_common/src/config.rs"
sub(cfg, 'pub static ref APP_NAME: RwLock<String> = RwLock::new("RustDesk".to_owned());',
    f'pub static ref APP_NAME: RwLock<String> = RwLock::new("{APP}".to_owned());')
sub(cfg, 'pub const RENDEZVOUS_SERVERS: &[&str] = &["rs-ny.rustdesk.com"];',
    f'pub const RENDEZVOUS_SERVERS: &[&str] = &["{SERVER}"];')
sub(cfg, 'pub const RS_PUB_KEY: &str = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";',
    f'pub const RS_PUB_KEY: &str = "{SERVER_KEY}";')

# --- fit the remote screen to the window by default on desktop --------------
sub(cfg,
    '            #[cfg(not(any(target_os = "android", target_os = "ios")))]\n'
    '            keys::OPTION_VIEW_STYLE => self.get_string(key, "original", vec!["adaptive"]),',
    '            #[cfg(not(any(target_os = "android", target_os = "ios")))]\n'
    '            keys::OPTION_VIEW_STYLE => self.get_string(key, "adaptive", vec!["original"]),')

# --- FreeDesk is its own stock client, not a RustDesk "custom client" -------
common = "src/common.rs"
sub(common, 'pub fn is_custom_client() -> bool {\n    get_app_name() != "RustDesk"\n}',
    'pub fn is_custom_client() -> bool {\n    false\n}')

# --- update check: GitHub releases of the FreeDesk repository ---------------
sub(common, '["rustdesk", "rustdesk", "releases", "tag", release_id]',
    f'["{GITHUB_OWNER}", "{GITHUB_REPO}", "releases", "tag", release_id]')
sub(common, '["rustdesk", "rustdesk", "releases", "tag", release_id, ""]',
    f'["{GITHUB_OWNER}", "{GITHUB_REPO}", "releases", "tag", release_id, ""]')
sub(common,
    '    let (request, url) =\n'
    '        hbb_common::version_check_request(hbb_common::VER_TYPE_RUSTDESK_CLIENT.to_string());\n',
    f'    let url = "{VERSION_URL}".to_owned();\n')
sub(common, 'client.post(&url).json(&request).send().await', 'client.get(&url).send().await', 2)

art = "src/updater/artifact.rs"
sub(art, 'format!("https://github.com/rustdesk/rustdesk/releases/download/{release_id}/");',
    f'format!("https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/download/{{release_id}}/");')
sub(art, '    if owner != "rustdesk"\n        || repo != "rustdesk"\n',
    f'    if owner != "{GITHUB_OWNER}"\n        || repo != "{GITHUB_REPO}"\n')

sub("src/update_metadata.rs",
    "        52, 214, 32, 65, 191, 134, 137, 75, 157, 74, 67, 221, 150, 161, 118, 215, 218, 35, 236,\n"
    "        156, 127, 120, 133, 156, 197, 141, 37, 22, 47, 106, 181, 177,\n",
    "        " + ", ".join(str(b) for b in UPDATE_PUBLIC_KEY[:16]) + ",\n"
    "        " + ", ".join(str(b) for b in UPDATE_PUBLIC_KEY[16:]) + ",\n")

sub("src/manual_update.rs", 'const PUBLIC_MACOS_BUNDLE_ID: &str = "com.carriez.rustdesk";',
    f'const PUBLIC_MACOS_BUNDLE_ID: &str = "{BUNDLE_ID}";')

# --- update card in the desktop UI -----------------------------------------
home = "flutter/lib/desktop/pages/desktop_home_page.dart"
sub(home, "bind.mainUriPrefixSync().contains('rustdesk')",
    f"bind.mainUriPrefixSync().contains('{APP_LOWER}')")
sub(home, "final Uri url = Uri.parse('https://rustdesk.com/download');",
    f"final Uri url = Uri.parse('https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest');")
sub(home, "'https://github.com/rustdesk/rustdesk/releases/tag/${bind.mainGetNewVersion()}'",
    f"'https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/tag/${{bind.mainGetNewVersion()}}'")

# --- Windows metadata -------------------------------------------------------
rc = "flutter/windows/runner/Runner.rc"
sub(rc, 'VALUE "FileDescription", "RustDesk Remote Desktop" "\\0"',
    f'VALUE "FileDescription", "{APP} Remote Desktop" "\\0"')
sub(rc, 'VALUE "InternalName", "rustdesk" "\\0"', f'VALUE "InternalName", "{APP_LOWER}" "\\0"')
sub(rc, 'VALUE "OriginalFilename", "rustdesk.exe" "\\0"',
    f'VALUE "OriginalFilename", "{APP_LOWER}.exe" "\\0"')
sub(rc, 'VALUE "ProductName", "RustDesk" "\\0"', f'VALUE "ProductName", "{APP}" "\\0"')
for toml in ("Cargo.toml", "libs/portable/Cargo.toml"):
    sub(toml, 'ProductName = "RustDesk"', f'ProductName = "{APP}"')
    sub(toml, 'FileDescription = "RustDesk Remote Desktop"',
        f'FileDescription = "{APP} Remote Desktop"')
    sub(toml, 'OriginalFilename = "rustdesk.exe"', f'OriginalFilename = "{APP_LOWER}.exe"')
sub("libs/portable/src/main.rs", 'const APP_PREFIX: &str = "rustdesk";',
    f'const APP_PREFIX: &str = "{APP_LOWER}";')

# --- macOS bundle -----------------------------------------------------------
sub("flutter/macos/Runner/Configs/AppInfo.xcconfig", "PRODUCT_NAME = RustDesk", f"PRODUCT_NAME = {APP}")
sub("flutter/macos/Runner/Configs/AppInfo.xcconfig",
    "PRODUCT_BUNDLE_IDENTIFIER = com.carriez.flutterHbb", f"PRODUCT_BUNDLE_IDENTIFIER = {BUNDLE_ID}")
pbx = "flutter/macos/Runner.xcodeproj/project.pbxproj"
sub(pbx, "PRODUCT_BUNDLE_IDENTIFIER = com.carriez.rustdesk;", f"PRODUCT_BUNDLE_IDENTIFIER = {BUNDLE_ID};", 3)
sub(pbx, "RustDesk.app", f"{APP}.app", 4)
sub("flutter/macos/Runner.xcodeproj/xcshareddata/xcschemes/Runner.xcscheme",
    'BuildableName = "RustDesk.app"', f'BuildableName = "{APP}.app"', 4)
plist = "flutter/macos/Runner/Info.plist"
sub(plist, "<string>com.carriez.rustdesk</string>", f"<string>{BUNDLE_ID}</string>")
sub(plist, "<string>rustdesk</string>", f"<string>{APP_LOWER}</string>")
sub("flutter/macos/Runner/Base.lproj/MainMenu.xib", 'customModule="RustDesk"', f'customModule="{APP}"', 2)
sub("build.py", "Release/RustDesk.app", f"Release/{APP}.app", 2)
sub("build.py", "--icon RustDesk.app 200 190 --hide-extension RustDesk.app",
    f"--icon {APP}.app 200 190 --hide-extension {APP}.app")
sub("build.py", '--volname \\"RustDesk Installer\\"', f'--volname \\"{APP} Installer\\"')

print("FreeDesk branding applied.")
