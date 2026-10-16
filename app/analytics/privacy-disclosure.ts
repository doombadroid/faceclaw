import { APP_NAME } from "../branding";

/** Conditional wording: also shown on self-built iOS apps, where TestFlight does not apply. */
export const IOS_PRIVACY_NOTICE = [
  `If installed with TestFlight, Apple automatically collects crash logs, installs, sessions, and device/app details and shares them with ${APP_NAME}'s developers. This continues even when ${APP_NAME} statistics are None; the app cannot turn it off.`,
  "Joining only through a public link hides your name and email from us, not from Apple. Email invitations can identify you. Optional feedback can disclose your email, comments, screenshots and diagnostics. Review what you send.",
  `iPhone Settings > Privacy & Security > Analytics & Improvements controls ordinary iOS analytics. It does not stop TestFlight crash reports. ${APP_NAME} cannot change Apple's analytics settings.`,
  // The TestFlight listing keeps the App Store Connect name.
  "To leave the beta, open Faceclaw in TestFlight and choose Stop Testing, then stop using and uninstall the beta. This does not erase earlier reports. Details: Settings > Privacy > Privacy policy.",
].join("\n\n");

export const IOS_PRIVACY_SUMMARY =
  "With TestFlight, crash/usage reports continue even with None. Open iOS / TestFlight privacy for details.";
