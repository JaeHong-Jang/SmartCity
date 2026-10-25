// Simulator-mode phase machine. Illegal transitions are ignored (return the same phase).

export type SimPhase = 'off' | 'warming' | 'ready' | 'comparing';
export type SimAction = 'enter' | 'warmedUp' | 'compare' | 'compareDone' | 'compareCancel' | 'restart' | 'exit';

const TABLE: Record<SimPhase, Partial<Record<SimAction, SimPhase>>> = {
  off: { enter: 'warming' },
  warming: { warmedUp: 'ready', restart: 'warming', exit: 'off' },
  ready: { compare: 'comparing', restart: 'warming', exit: 'off' },
  comparing: { compareDone: 'ready', compareCancel: 'ready', restart: 'warming', exit: 'off' },
};

export function transition(phase: SimPhase, action: SimAction): SimPhase {
  return TABLE[phase][action] ?? phase;
}
