export interface MapDesignToolObservation {
  phase: 'discovery' | 'final';
  step: number;
  tool: string;
  args: unknown;
  result: unknown;
}
