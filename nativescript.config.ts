import { NativeScriptConfig } from '@nativescript/core';

export default {
  id: 'com.faceclaw.app',
  appPath: 'app',
  appResourcesPath: 'App_Resources',
  ios: {
    // Runtime 9.0 terminates a release build on any uncaught JS error (one thrown in a native callback
    // or timer); discarded, it reaches Application.discardedErrorEvent, logged in bootstrap.ios.ts.
    // oxlint-disable-next-line typescript/no-deprecated -- deprecated only from runtime 9.1, which no longer crashes
    discardUncaughtJsExceptions: true,
    // FluidAudio runs the on-device Parakeet speech model (App_Resources/iOS/src/FaceclawParakeet.swift).
    // An exact version pins it; it needs iOS 17 (build.xcconfig). The CLI only warns when this
    // fails to apply, so CI checks the generated project references it.
    SPMPackages: [{
      name: 'FluidAudio',
      libs: ['FluidAudio'],
      repositoryURL: 'https://github.com/FluidInference/FluidAudio.git',
      version: '0.17.7',
    }],
  },
  android: {
    v8Flags: '--expose_gc',
    markingMode: 'none'
  }
} as NativeScriptConfig;