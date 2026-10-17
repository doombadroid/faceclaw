import type { FluidNative } from "./parakeet";

export type { FluidNative } from "./parakeet";

declare const FaceclawParakeet: FluidNative;

/** FaceclawParakeet.swift (selectors as its @objc names give them). */
export function fluidNative(): FluidNative | null {
  return FaceclawParakeet;
}
