import { type AppDefinition } from "../app-definition";
import { createKlipperAppWindow, KLIPPER_SURFACE_ID, KLIPPER_WINDOW_ID } from "./klipper-app";

const klipperApp: AppDefinition = {
  appId: "klipper",
  title: "KlipKommander",
  icon: "printer-3d",
  launch: (ctx) => ctx.launchInProcessApp(KLIPPER_WINDOW_ID, KLIPPER_SURFACE_ID, createKlipperAppWindow),
};

export default klipperApp;
