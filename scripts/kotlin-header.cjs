#!/usr/bin/env node
/**
 * Regenerates native/kotlin/FaceclawKit.h.snapshot, the Kotlin/Native ObjC header that
 * scripts/check-native-names.cjs checks the iOS JavaScript against, on Linux.
 *
 * Kotlin/Native only builds Apple frameworks on a macOS host, but the header comes from the
 * compiler front end: claiming a macOS host and omitting the framework binary produces it with
 * no Xcode or macOS toolchain (byte-identical to CI's on 2026-10-17). Also writes
 * FaceclawKit.h.sources, the hash of the Kotlin sources it came from, which npm test compares.
 *
 * Usage: npm run kotlin-header   (needs JAVA_HOME and ANDROID_HOME, e.g. from build_paths.sh)
 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { kotlinSourcesHash } = require('./check-native-names.cjs');

const ROOT = path.join(__dirname, '..');
const KOTLIN = path.join(ROOT, 'native/kotlin');
const KLIB = path.join(KOTLIN, 'shared/build/classes/kotlin/iosArm64/main/klib/shared');

execFileSync(path.join(ROOT, 'wear/gradlew'), ['-q', '-p', KOTLIN, ':shared:compileKotlinIosArm64'], { stdio: 'inherit' });

const version = fs.readFileSync(path.join(KLIB, 'default/manifest'), 'utf8').match(/^compiler_version=(.+)$/m)[1];
const konan = path.join(os.homedir(), '.konan', `kotlin-native-prebuilt-linux-x86_64-${version}`);
if (!fs.existsSync(konan)) throw new Error(`Kotlin/Native ${version} is not in ${konan} (Gradle downloads it)`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclawkit-header-'));
const empty = path.join(scratch, 'empty');
fs.mkdirSync(empty);
try {
  execFileSync(path.join(konan, 'bin/konanc'), [
    '-J-Dos.name=Mac OS X', '-J-Dos.arch=aarch64',
    // Nothing runs the macOS toolchain, so do not download it (4 GB).
    `-Xoverride-konan-properties=dependencies.macos_arm64=;llvmHome.macos_arm64=${empty};libffiDir.macos_arm64=${empty};airplaneMode=true`,
    // The flags the Gradle framework build passes (shared/build.gradle.kts).
    '-target', 'ios_arm64', '-produce', 'framework', '-Xomit-framework-binary', '-Xstatic-framework',
    '-Xbinary=bundleId=com.faceclaw.shared', '-Xexport-kdoc',
    '-library', KLIB, `-Xinclude=${KLIB}`, '-o', path.join(scratch, 'FaceclawKit'),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.copyFileSync(path.join(scratch, 'FaceclawKit.framework/Headers/FaceclawKit.h'), path.join(KOTLIN, 'FaceclawKit.h.snapshot'));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
fs.writeFileSync(path.join(KOTLIN, 'FaceclawKit.h.sources'), `${kotlinSourcesHash()}\n`);
console.log('kotlin-header: wrote native/kotlin/FaceclawKit.h.snapshot');
