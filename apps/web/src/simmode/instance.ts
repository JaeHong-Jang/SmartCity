// The page's single SimModeController, set by main.tsx (UI components reach it from here).

import type { SimModeController } from './controller';

let controller: SimModeController | null = null;

export function setSimModeController(c: SimModeController): void {
  controller = c;
}

export function simModeController(): SimModeController {
  if (!controller) throw new Error('SimModeController missing');
  return controller;
}
