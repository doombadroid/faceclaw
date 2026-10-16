// NativeScript globals the compiled app modules read (app/branding.ts). Under
// node they are undefined, so tests see the Android wording.
declare const global: { isIOS?: boolean; isAndroid?: boolean };
