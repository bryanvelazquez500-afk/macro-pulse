/** The one motion curve (--ease-flow) and durations (--dur-1/2/3) for Framer Motion, matching globals.css. */
export const EASE_FLOW = [0.22, 1, 0.36, 1] as const;
export const DUR = { 1: 0.14, 2: 0.24, 3: 0.42 } as const;
export const flow = (d: keyof typeof DUR = 2) => ({ duration: DUR[d], ease: EASE_FLOW });
