import type { FluidNative } from "./parakeet";

export type { FluidNative } from "./parakeet";


/** FaceclawParakeet.swift (selectors as its @objc names give them). */
export function fluidNative(): FluidNative | null {
  return FaceclawParakeet;
}
